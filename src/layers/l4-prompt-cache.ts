// l4-prompt-cache.ts
import { createHash } from 'node:crypto';
import type {
  CacheContentType,
  CacheEntry,
  CacheMarkedContent,
  CacheStats,
} from '../types/index.js';

/**
 * PromptCacheOrchestrator — L4
 *
 * Owns Anthropic prompt-cache logic: decides what to mark with
 * `cache_control: { type: 'ephemeral' }`, tracks hit/miss statistics
 * per session, and signals when breakpoints should be re-evaluated.
 *
 * Pricing model (reference):
 *  - cache-write: 125% of base price
 *  - cache-read:   10% of base price (≈90% latency + cost savings)
 *
 * Break-even: a cached block must be hit at least ~2x per 5-minute
 * window for the write premium to pay off.
 */
export class PromptCacheOrchestrator {
  /** Threshold (chars) above which a 'context' block is worth caching. */
  private static readonly CONTEXT_MIN_CHARS = 1000;

  /** Number of consecutive MISSes that triggers a breakpoint re-adjust. */
  private static readonly MISS_STREAK_THRESHOLD = 3;

  private entries = new Map<string, CacheEntry>();
  private hits = 0;
  private misses = 0;
  private consecutiveMisses = 0;

  /**
   * Decide whether a piece of content should be marked with a
   * cache_control breakpoint.
   */
  shouldCache(content: string, type: CacheContentType): boolean {
    if (type === 'system') return true;
    if (type === 'tool_schema') return true;
    // type === 'context'
    return content.length > PromptCacheOrchestrator.CONTEXT_MIN_CHARS;
  }

  /**
   * Wrap content with the cache_control hint Anthropic expects.
   */
  markForCache(content: string): CacheMarkedContent {
    return {
      content,
      cache_control: { type: 'ephemeral' },
    };
  }

  /**
   * Record a cache hit. Resets the consecutive-miss streak and
   * bumps the per-entry hit counter if we're tracking this content.
   */
  recordHit(content?: string): void {
    this.hits++;
    this.consecutiveMisses = 0;
    if (content !== undefined) {
      const hash = this.hash(content);
      const entry = this.entries.get(hash);
      if (entry) {
        entry.hitCount++;
        entry.lastHitAt = Date.now();
      }
    }
  }

  /**
   * Record a cache miss. Increments the consecutive-miss streak,
   * which `shouldAdjustBreakpoint` uses to signal re-placement.
   * Optionally registers the content as a new tracked entry.
   */
  recordMiss(content?: string, type: CacheContentType = 'context'): void {
    this.misses++;
    this.consecutiveMisses++;
    if (content !== undefined) {
      const hash = this.hash(content);
      if (!this.entries.has(hash)) {
        const now = Date.now();
        this.entries.set(hash, {
          content,
          hash,
          createdAt: now,
          hitCount: 0,
          lastHitAt: 0,
          type,
        });
      }
    }
  }

  /**
   * Compute session-level cache statistics.
   * hitRate and estimatedSavingsPct are 0 (not NaN) when no events seen.
   */
  getStats(): CacheStats {
    const total = this.hits + this.misses;
    if (total === 0) {
      return { hits: 0, misses: 0, hitRate: 0, estimatedSavingsPct: 0 };
    }
    const hitRate = this.hits / total;
    // cache-read saves ~90% vs a fresh read, so the expected savings
    // as a share of total-request cost is hitRate * 0.9, rendered %.
    const estimatedSavingsPct = hitRate * 0.9 * 100;
    return {
      hits: this.hits,
      misses: this.misses,
      hitRate,
      estimatedSavingsPct,
    };
  }

  /**
   * Signal that breakpoints should be re-evaluated because we've
   * seen N consecutive MISSes — suggesting the cache_control markers
   * are positioned incorrectly (e.g., below content that varies per
   * request).
   */
  shouldAdjustBreakpoint(): boolean {
    return (
      this.consecutiveMisses >=
      PromptCacheOrchestrator.MISS_STREAK_THRESHOLD
    );
  }

  /** Reset all session state — primarily for tests. */
  reset(): void {
    this.entries.clear();
    this.hits = 0;
    this.misses = 0;
    this.consecutiveMisses = 0;
  }

  /** Expose tracked entries for introspection (read-only view). */
  getEntries(): ReadonlyMap<string, CacheEntry> {
    return this.entries;
  }

  private hash(content: string): string {
    return createHash('sha256').update(content).digest('hex');
  }
}
