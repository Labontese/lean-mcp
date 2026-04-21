import { describe, it, expect, beforeEach } from 'vitest';
import { ObservabilityBus } from '../src/layers/l6-observability.js';
import type { LayerName } from '../src/types/index.js';

describe('L6 ObservabilityBus', () => {
  let bus: ObservabilityBus;

  beforeEach(() => {
    bus = new ObservabilityBus();
  });

  describe('emit', () => {
    it('assigns auto-incrementing id and timestamp to every event', () => {
      const before = Date.now();
      bus.emit({ layer: 'l1', operation: 'search_tools' });
      bus.emit({ layer: 'l1', operation: 'search_tools' });
      bus.emit({ layer: 'l4', operation: 'cache_hit' });
      const after = Date.now();

      const events = bus.getRecentEvents();
      expect(events).toHaveLength(3);
      expect(events[0].id).toBe(1);
      expect(events[1].id).toBe(2);
      expect(events[2].id).toBe(3);
      for (const ev of events) {
        expect(ev.timestamp).toBeGreaterThanOrEqual(before);
        expect(ev.timestamp).toBeLessThanOrEqual(after);
      }
    });

    it('preserves metadata and token fields verbatim', () => {
      bus.emit({
        layer: 'l1',
        operation: 'search_tools',
        tokensBefore: 100,
        tokensAfter: 30,
        latencyMs: 12,
        metadata: { query: 'read', resultCount: 4 },
      });
      const [ev] = bus.getRecentEvents();
      expect(ev.tokensBefore).toBe(100);
      expect(ev.tokensAfter).toBe(30);
      expect(ev.latencyMs).toBe(12);
      expect(ev.metadata).toEqual({ query: 'read', resultCount: 4 });
    });
  });

  describe('ring buffer', () => {
    it('caps retained events at 1000 and drops the oldest first', () => {
      // Emit 1005 events; the first 5 should be evicted.
      for (let i = 0; i < 1005; i++) {
        bus.emit({ layer: 'l1', operation: 'search_tools' });
      }
      const events = bus.getRecentEvents(2000);
      expect(events).toHaveLength(1000);
      // The oldest retained event must have id 6 (ids 1–5 evicted);
      // newest must be 1005.
      expect(events[0].id).toBe(6);
      expect(events[events.length - 1].id).toBe(1005);
      // Stats should reflect the current buffer, not the total emitted.
      expect(bus.getStats().totalEvents).toBe(1000);
    });
  });

  describe('getStats', () => {
    it('returns reductionPct 0 (not NaN) when no events have tokens', () => {
      const stats = bus.getStats();
      expect(stats.totalEvents).toBe(0);
      expect(stats.totalTokensBefore).toBe(0);
      expect(stats.totalTokensAfter).toBe(0);
      expect(stats.reductionPct).toBe(0);
      expect(Number.isNaN(stats.reductionPct)).toBe(false);
      expect(stats.byLayer).toEqual([]);
      expect(stats.topOperations).toEqual([]);
    });

    it('computes reductionPct correctly from aggregate token totals', () => {
      // 1000 before, 200 after → 80% reduction.
      bus.emit({ layer: 'l3', operation: 'compress', tokensBefore: 600, tokensAfter: 100 });
      bus.emit({ layer: 'l3', operation: 'compress', tokensBefore: 400, tokensAfter: 100 });
      const stats = bus.getStats();
      expect(stats.totalTokensBefore).toBe(1000);
      expect(stats.totalTokensAfter).toBe(200);
      expect(stats.reductionPct).toBeCloseTo(80, 10);
    });

    it('aggregates byLayer correctly across multiple layers', () => {
      bus.emit({ layer: 'l1', operation: 'search_tools', tokensBefore: 100, tokensAfter: 10, latencyMs: 10 });
      bus.emit({ layer: 'l1', operation: 'search_tools', tokensBefore: 100, tokensAfter: 20, latencyMs: 20 });
      bus.emit({ layer: 'l4', operation: 'cache_hit', tokensBefore: 200, tokensAfter: 20, latencyMs: 5 });

      const { byLayer } = bus.getStats();
      const l1 = byLayer.find((b) => b.layer === 'l1');
      const l4 = byLayer.find((b) => b.layer === 'l4');

      expect(l1).toBeDefined();
      expect(l1?.eventCount).toBe(2);
      expect(l1?.totalTokensSaved).toBe(170); // (100-10)+(100-20)
      expect(l1?.avgLatencyMs).toBeCloseTo(15, 10);

      expect(l4).toBeDefined();
      expect(l4?.eventCount).toBe(1);
      expect(l4?.totalTokensSaved).toBe(180);
      expect(l4?.avgLatencyMs).toBeCloseTo(5, 10);
    });

    it('topOperations returns at most 5 entries, sorted by tokensSaved desc', () => {
      // 7 distinct operations — only top 5 should survive.
      const ops: Array<[string, number]> = [
        ['op_a', 10],
        ['op_b', 50],
        ['op_c', 30],
        ['op_d', 100],
        ['op_e', 20],
        ['op_f', 5],
        ['op_g', 80],
      ];
      for (const [operation, saved] of ops) {
        bus.emit({
          layer: 'l1',
          operation,
          tokensBefore: saved + 10,
          tokensAfter: 10,
        });
      }

      const { topOperations } = bus.getStats();
      expect(topOperations).toHaveLength(5);
      expect(topOperations.map((o) => o.operation)).toEqual([
        'op_d', // 100
        'op_g', // 80
        'op_b', // 50
        'op_c', // 30
        'op_e', // 20
      ]);
      expect(topOperations[0].tokensSaved).toBe(100);
      expect(topOperations[0].count).toBe(1);
    });

    it('topOperations returns an empty array when there are no events', () => {
      expect(bus.getStats().topOperations).toEqual([]);
    });

    it('aggregates events from multiple layers into the correct buckets', () => {
      const layers: LayerName[] = ['l1', 'l2', 'l3', 'l4', 'l5'];
      for (const layer of layers) {
        bus.emit({ layer, operation: `${layer}_op`, tokensBefore: 100, tokensAfter: 50 });
        bus.emit({ layer, operation: `${layer}_op`, tokensBefore: 100, tokensAfter: 50 });
      }
      const { byLayer, totalEvents, totalTokensBefore, totalTokensAfter } = bus.getStats();
      expect(totalEvents).toBe(10);
      expect(totalTokensBefore).toBe(1000);
      expect(totalTokensAfter).toBe(500);
      expect(byLayer).toHaveLength(5);
      for (const entry of byLayer) {
        expect(entry.eventCount).toBe(2);
        expect(entry.totalTokensSaved).toBe(100);
      }
    });
  });

  describe('getRecentEvents', () => {
    it('returns the last N events in chronological order when limit given', () => {
      for (let i = 0; i < 10; i++) {
        bus.emit({ layer: 'l1', operation: 'op', metadata: { i } });
      }
      const last3 = bus.getRecentEvents(3);
      expect(last3).toHaveLength(3);
      expect(last3.map((e) => e.id)).toEqual([8, 9, 10]);
    });

    it('defaults to 50 when no limit is provided', () => {
      for (let i = 0; i < 120; i++) {
        bus.emit({ layer: 'l1', operation: 'op' });
      }
      const events = bus.getRecentEvents();
      expect(events).toHaveLength(50);
      expect(events[0].id).toBe(71); // 120 - 50 + 1
      expect(events[events.length - 1].id).toBe(120);
    });

    it('returns all events when limit exceeds buffer size', () => {
      bus.emit({ layer: 'l1', operation: 'op' });
      bus.emit({ layer: 'l2', operation: 'op' });
      expect(bus.getRecentEvents(999)).toHaveLength(2);
    });
  });

  describe('clear', () => {
    it('empties the event log and resets id counter', () => {
      bus.emit({ layer: 'l1', operation: 'op', tokensBefore: 100, tokensAfter: 10 });
      bus.emit({ layer: 'l1', operation: 'op', tokensBefore: 100, tokensAfter: 10 });
      expect(bus.getStats().totalEvents).toBe(2);

      bus.clear();

      expect(bus.getRecentEvents()).toEqual([]);
      const stats = bus.getStats();
      expect(stats.totalEvents).toBe(0);
      expect(stats.totalTokensBefore).toBe(0);
      expect(stats.totalTokensAfter).toBe(0);
      expect(stats.reductionPct).toBe(0);
      expect(stats.byLayer).toEqual([]);
      expect(stats.topOperations).toEqual([]);

      // New events after clear() start from id 1 again.
      bus.emit({ layer: 'l1', operation: 'op' });
      expect(bus.getRecentEvents()[0].id).toBe(1);
    });
  });

  describe('sessionId', () => {
    it('is stable across calls within a single instance', () => {
      const a = bus.getStats().sessionId;
      bus.emit({ layer: 'l1', operation: 'op' });
      const b = bus.getStats().sessionId;
      expect(a).toBe(b);
      expect(a).toBe(bus.getSessionId());
      // UUID v4 shape sanity check.
      expect(a).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      );
    });

    it('is preserved across clear() — only events are wiped', () => {
      const before = bus.getSessionId();
      bus.emit({ layer: 'l1', operation: 'op' });
      bus.clear();
      expect(bus.getSessionId()).toBe(before);
    });

    it('differs between separate instances', () => {
      const other = new ObservabilityBus();
      expect(other.getSessionId()).not.toBe(bus.getSessionId());
    });
  });
});
