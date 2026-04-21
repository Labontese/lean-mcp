// l2-semantic-dedup.ts
import { createHash } from 'node:crypto';
import type { DedupConfig, DedupResult } from '../types/index.js';
import type { ObservabilityBus } from './l6-observability.js';

/**
 * SemanticDedup — L2
 *
 * Removes duplicated content from a list of context items before it is
 * sent to the model. Three levels are supported (embedding is a TODO):
 *
 *  1. Exact hash-match — O(1) via sha256 of the full string.
 *  2. Fuzzy match via Jaccard similarity over word 3-shingles — no
 *     external dependencies, pure JS.
 *  3. Embedding-match — NOT IMPLEMENTED. Would require a model loader
 *     (e.g. @xenova/transformers) with non-trivial install footprint.
 *
 * Defaults are intentionally conservative: fuzzyThreshold=0.97 means
 * "almost identical" until evals justify lowering it.
 *
 * Ordering is preserved: the first occurrence wins, later duplicates
 * are dropped. The internal seen-cache is bounded by `maxCacheSize`
 * with FIFO eviction so long-running sessions cannot leak memory.
 */
export class SemanticDedup {
  /** Rough 4-chars-per-token heuristic used by `estimatedTokensSaved`. */
  private static readonly CHARS_PER_TOKEN = 4;

  /** Shingle size for Jaccard similarity. 3-grams strike a good
   * balance between sensitivity and robustness for prose. */
  private static readonly SHINGLE_SIZE = 3;

  private static readonly DEFAULTS: DedupConfig = {
    exactMatch: true,
    fuzzyMatch: true,
    fuzzyThreshold: 0.97,
    maxCacheSize: 500,
  };

  private readonly config: DedupConfig;
  private readonly bus?: ObservabilityBus;

  /** Ordered list of hashes seen so far (used for FIFO eviction). */
  private seenHashes: string[] = [];
  /** Map from hash → original string for fuzzy lookups. */
  private seenByHash = new Map<string, string>();
  /** Cached shingle sets keyed by hash, to avoid recomputing per call. */
  private shingleCache = new Map<string, Set<string>>();

  constructor(config: Partial<DedupConfig> = {}, bus?: ObservabilityBus) {
    this.config = { ...SemanticDedup.DEFAULTS, ...config };
    // Defensive clamp — a nonsense threshold would quietly mis-classify.
    if (this.config.fuzzyThreshold < 0) this.config.fuzzyThreshold = 0;
    if (this.config.fuzzyThreshold > 1) this.config.fuzzyThreshold = 1;
    if (this.config.maxCacheSize < 1) this.config.maxCacheSize = 1;
    this.bus = bus;
  }

  /** Return a defensive copy of the effective config. */
  getConfig(): DedupConfig {
    return { ...this.config };
  }

  /**
   * Deduplicate `items`, preserving order and keeping the first
   * occurrence of each duplicate group.
   *
   * Emits a single `l2.deduplicate` observability event with
   * tokensBefore/tokensAfter based on character counts.
   */
  deduplicate(items: string[]): DedupResult {
    const start = Date.now();
    const original = [...items];
    const deduplicated: string[] = [];

    // Per-call seen sets so a single call is self-contained even
    // when the instance cache is shared across calls.
    const callHashes = new Set<string>();
    const callShingles: Array<{ hash: string; shingles: Set<string> }> = [];

    let charsBefore = 0;
    let charsAfter = 0;
    let charsRemoved = 0;
    let removedCount = 0;

    for (const item of original) {
      charsBefore += item.length;
      const h = this.hash(item);

      // 1) Exact match — cheapest possible test.
      if (this.config.exactMatch && callHashes.has(h)) {
        removedCount += 1;
        charsRemoved += item.length;
        continue;
      }

      // 2) Fuzzy match — only if we haven't already matched exactly.
      let isDup = false;
      if (this.config.fuzzyMatch) {
        const shingles = this.shingles(item);
        for (const prev of callShingles) {
          const sim = this.jaccard(shingles, prev.shingles);
          if (sim >= this.config.fuzzyThreshold) {
            isDup = true;
            break;
          }
        }
        if (!isDup) {
          callShingles.push({ hash: h, shingles });
        }
      }

      if (isDup) {
        removedCount += 1;
        charsRemoved += item.length;
        continue;
      }

      // Keeper: add to outputs and to the instance-level cache.
      deduplicated.push(item);
      callHashes.add(h);
      charsAfter += item.length;
      this.remember(h, item);
    }

    const estimatedTokensSaved =
      removedCount === 0
        ? 0
        : Math.max(
            1,
            Math.round(charsRemoved / SemanticDedup.CHARS_PER_TOKEN),
          );

    const tokensBefore = Math.round(charsBefore / SemanticDedup.CHARS_PER_TOKEN);
    const tokensAfter = Math.round(charsAfter / SemanticDedup.CHARS_PER_TOKEN);

    this.bus?.emit({
      layer: 'l2',
      operation: 'deduplicate',
      tokensBefore,
      tokensAfter,
      latencyMs: Date.now() - start,
      metadata: {
        inputCount: original.length,
        outputCount: deduplicated.length,
        removedCount,
        fuzzyThreshold: this.config.fuzzyThreshold,
      },
    });

    return {
      original,
      deduplicated,
      removedCount,
      estimatedTokensSaved,
    };
  }

  /**
   * Test whether two strings are duplicates under the current config.
   * Exact match is tried first, then fuzzy (if enabled).
   */
  isDuplicate(a: string, b: string): boolean {
    if (this.config.exactMatch && this.hash(a) === this.hash(b)) {
      return true;
    }
    if (this.config.fuzzyMatch) {
      const sim = this.jaccard(this.shingles(a), this.shingles(b));
      return sim >= this.config.fuzzyThreshold;
    }
    return false;
  }

  /** Empty the instance-level seen-cache (does not reset config). */
  clearCache(): void {
    this.seenHashes = [];
    this.seenByHash.clear();
    this.shingleCache.clear();
  }

  // ────────────────────────────────── internals ──────────────────────────────────

  private hash(s: string): string {
    return createHash('sha256').update(s).digest('hex');
  }

  /**
   * Produce word 3-shingles. Input is lower-cased and collapsed on
   * whitespace so trivial formatting differences don't defeat the match.
   * For strings with fewer than SHINGLE_SIZE tokens we fall back to the
   * full normalised string so short inputs still have a usable signature.
   */
  private shingles(s: string): Set<string> {
    const tokens = s
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .trim()
      .split(' ')
      .filter((t) => t.length > 0);

    const out = new Set<string>();
    if (tokens.length === 0) {
      return out;
    }
    if (tokens.length < SemanticDedup.SHINGLE_SIZE) {
      out.add(tokens.join(' '));
      return out;
    }
    for (let i = 0; i <= tokens.length - SemanticDedup.SHINGLE_SIZE; i++) {
      out.add(tokens.slice(i, i + SemanticDedup.SHINGLE_SIZE).join(' '));
    }
    return out;
  }

  private jaccard(a: Set<string>, b: Set<string>): number {
    if (a.size === 0 && b.size === 0) return 1;
    if (a.size === 0 || b.size === 0) return 0;

    let intersection = 0;
    // Iterate the smaller set for a cheaper inner loop.
    const [small, big] = a.size <= b.size ? [a, b] : [b, a];
    for (const item of small) {
      if (big.has(item)) intersection += 1;
    }
    const union = a.size + b.size - intersection;
    return union === 0 ? 0 : intersection / union;
  }

  private remember(hash: string, item: string): void {
    if (this.seenByHash.has(hash)) return;
    this.seenByHash.set(hash, item);
    this.seenHashes.push(hash);
    while (this.seenHashes.length > this.config.maxCacheSize) {
      const evicted = this.seenHashes.shift();
      if (evicted !== undefined) {
        this.seenByHash.delete(evicted);
        this.shingleCache.delete(evicted);
      }
    }
  }
}
