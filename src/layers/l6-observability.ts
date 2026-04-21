// l6-observability.ts
import { randomUUID } from 'node:crypto';
import type {
  LayerName,
  LayerStats,
  ObservabilityEvent,
  SessionStats,
} from '../types/index.js';

/**
 * ObservabilityBus — L6
 *
 * In-memory event bus that all other layers (L1–L5) emit optimisation
 * events to. Keeps a bounded ring buffer of the most recent events and
 * exposes aggregated session statistics via `getStats()`.
 *
 * Design goals:
 *  - Zero external dependencies, synchronous emit (call-site is hot).
 *  - Bounded memory: ring buffer capped at MAX_EVENTS; oldest dropped.
 *  - Safe aggregation: never returns NaN — empty state returns 0.
 *  - Stable sessionId per instance so dashboards can correlate events.
 */
export class ObservabilityBus {
  /** Maximum events retained in the ring buffer. */
  private static readonly MAX_EVENTS = 1000;

  /** Max operations returned by topOperations aggregation. */
  private static readonly TOP_OPERATIONS_LIMIT = 5;

  /** Default N for getRecentEvents(). */
  private static readonly DEFAULT_RECENT_LIMIT = 50;

  private readonly sessionId: string;
  private readonly startedAt: number;
  private events: ObservabilityEvent[] = [];
  private nextId = 1;

  constructor() {
    this.sessionId = randomUUID();
    this.startedAt = Date.now();
  }

  /** Stable session identifier generated once per instance. */
  getSessionId(): string {
    return this.sessionId;
  }

  /**
   * Record an event. `id` and `timestamp` are assigned automatically.
   * When the buffer is full, the oldest event is dropped.
   */
  emit(event: Omit<ObservabilityEvent, 'id' | 'timestamp'>): void {
    const full: ObservabilityEvent = {
      ...event,
      id: this.nextId++,
      timestamp: Date.now(),
    };
    this.events.push(full);
    if (this.events.length > ObservabilityBus.MAX_EVENTS) {
      this.events.shift();
    }
  }

  /**
   * Aggregate all retained events into a `SessionStats` snapshot.
   * All numeric outputs are guaranteed non-NaN.
   */
  getStats(): SessionStats {
    let totalTokensBefore = 0;
    let totalTokensAfter = 0;

    // Per-layer aggregation buckets.
    const layerBuckets = new Map<
      LayerName,
      { eventCount: number; tokensSaved: number; latencySum: number; latencyCount: number }
    >();

    // Per-operation aggregation buckets.
    const opBuckets = new Map<string, { count: number; tokensSaved: number }>();

    for (const ev of this.events) {
      const before = ev.tokensBefore ?? 0;
      const after = ev.tokensAfter ?? 0;
      totalTokensBefore += before;
      totalTokensAfter += after;
      const saved = Math.max(0, before - after);

      const layerBucket = layerBuckets.get(ev.layer) ?? {
        eventCount: 0,
        tokensSaved: 0,
        latencySum: 0,
        latencyCount: 0,
      };
      layerBucket.eventCount += 1;
      layerBucket.tokensSaved += saved;
      if (typeof ev.latencyMs === 'number') {
        layerBucket.latencySum += ev.latencyMs;
        layerBucket.latencyCount += 1;
      }
      layerBuckets.set(ev.layer, layerBucket);

      const opBucket = opBuckets.get(ev.operation) ?? { count: 0, tokensSaved: 0 };
      opBucket.count += 1;
      opBucket.tokensSaved += saved;
      opBuckets.set(ev.operation, opBucket);
    }

    const byLayer: LayerStats[] = [];
    for (const [layer, b] of layerBuckets) {
      byLayer.push({
        layer,
        eventCount: b.eventCount,
        totalTokensSaved: b.tokensSaved,
        avgLatencyMs: b.latencyCount === 0 ? 0 : b.latencySum / b.latencyCount,
      });
    }
    // Deterministic order: l1 → l6.
    byLayer.sort((a, b) => a.layer.localeCompare(b.layer));

    const topOperations = [...opBuckets.entries()]
      .map(([operation, b]) => ({
        operation,
        count: b.count,
        tokensSaved: b.tokensSaved,
      }))
      .sort((a, b) => {
        // Primary: tokensSaved desc. Tiebreak: count desc, then name asc
        // so the ordering is deterministic for tests.
        if (b.tokensSaved !== a.tokensSaved) return b.tokensSaved - a.tokensSaved;
        if (b.count !== a.count) return b.count - a.count;
        return a.operation.localeCompare(b.operation);
      })
      .slice(0, ObservabilityBus.TOP_OPERATIONS_LIMIT);

    const reductionPct =
      totalTokensBefore === 0
        ? 0
        : (1 - totalTokensAfter / totalTokensBefore) * 100;

    return {
      sessionId: this.sessionId,
      startedAt: this.startedAt,
      totalEvents: this.events.length,
      totalTokensBefore,
      totalTokensAfter,
      reductionPct,
      byLayer,
      topOperations,
    };
  }

  /**
   * Return the most recent events, newest last (chronological order).
   * Default limit is 50.
   */
  getRecentEvents(limit?: number): ObservabilityEvent[] {
    const n = typeof limit === 'number' && limit >= 0
      ? limit
      : ObservabilityBus.DEFAULT_RECENT_LIMIT;
    if (n === 0) return [];
    if (n >= this.events.length) return [...this.events];
    return this.events.slice(this.events.length - n);
  }

  /** Empty the ring buffer. Session id and startedAt are preserved. */
  clear(): void {
    this.events = [];
    this.nextId = 1;
  }
}
