import { describe, it, expect, beforeEach } from 'vitest';
import { PromptCacheOrchestrator } from '../src/layers/l4-prompt-cache.js';

const SHORT = 'a'.repeat(500);
const LONG = 'b'.repeat(1500);
const EXACTLY_1000 = 'c'.repeat(1000);
const JUST_OVER_1000 = 'd'.repeat(1001);

describe('L4 PromptCacheOrchestrator', () => {
  let cache: PromptCacheOrchestrator;

  beforeEach(() => {
    cache = new PromptCacheOrchestrator();
  });

  describe('shouldCache', () => {
    it('returns true for system content regardless of length', () => {
      expect(cache.shouldCache('', 'system')).toBe(true);
      expect(cache.shouldCache(SHORT, 'system')).toBe(true);
      expect(cache.shouldCache(LONG, 'system')).toBe(true);
    });

    it('returns true for tool_schema content regardless of length', () => {
      expect(cache.shouldCache('', 'tool_schema')).toBe(true);
      expect(cache.shouldCache(SHORT, 'tool_schema')).toBe(true);
      expect(cache.shouldCache(LONG, 'tool_schema')).toBe(true);
    });

    it('returns true for context content longer than 1000 chars', () => {
      expect(cache.shouldCache(LONG, 'context')).toBe(true);
      expect(cache.shouldCache(JUST_OVER_1000, 'context')).toBe(true);
    });

    it('returns false for context content of 1000 chars or less', () => {
      expect(cache.shouldCache(SHORT, 'context')).toBe(false);
      expect(cache.shouldCache('', 'context')).toBe(false);
      expect(cache.shouldCache(EXACTLY_1000, 'context')).toBe(false);
    });
  });

  describe('markForCache', () => {
    it('wraps content in the cache_control ephemeral shape', () => {
      const result = cache.markForCache('hello world');
      expect(result).toEqual({
        content: 'hello world',
        cache_control: { type: 'ephemeral' },
      });
    });

    it('preserves the original content unchanged', () => {
      const original = '{"schema":"complex","nested":{"a":1}}';
      const result = cache.markForCache(original);
      expect(result.content).toBe(original);
    });
  });

  describe('recordHit / recordMiss', () => {
    it('updates hit and miss counters independently', () => {
      cache.recordHit();
      cache.recordHit();
      cache.recordMiss();
      const stats = cache.getStats();
      expect(stats.hits).toBe(2);
      expect(stats.misses).toBe(1);
    });

    it('tracks per-entry hit counts when content is provided', () => {
      const content = 'some-cached-system-prompt';
      cache.recordMiss(content, 'system'); // first seen → miss, registers entry
      cache.recordHit(content); // second seen → hit
      cache.recordHit(content); // third seen → hit

      const entries = cache.getEntries();
      // There must be exactly one entry keyed by hash, with 2 hits.
      expect(entries.size).toBe(1);
      const [entry] = [...entries.values()];
      expect(entry.hitCount).toBe(2);
      expect(entry.type).toBe('system');
      expect(entry.lastHitAt).toBeGreaterThan(0);
    });
  });

  describe('getStats', () => {
    it('returns 0 hitRate and savings (not NaN) with no events', () => {
      const stats = cache.getStats();
      expect(stats).toEqual({
        hits: 0,
        misses: 0,
        hitRate: 0,
        estimatedSavingsPct: 0,
      });
      expect(Number.isNaN(stats.hitRate)).toBe(false);
      expect(Number.isNaN(stats.estimatedSavingsPct)).toBe(false);
    });

    it('computes hitRate as hits / (hits + misses)', () => {
      cache.recordHit();
      cache.recordHit();
      cache.recordHit();
      cache.recordMiss();
      const stats = cache.getStats();
      expect(stats.hitRate).toBeCloseTo(0.75, 10);
    });

    it('computes estimatedSavingsPct as hitRate * 90', () => {
      // 4 hits / 1 miss → hitRate 0.8 → savings 72%
      cache.recordHit();
      cache.recordHit();
      cache.recordHit();
      cache.recordHit();
      cache.recordMiss();
      const stats = cache.getStats();
      expect(stats.hitRate).toBeCloseTo(0.8, 10);
      expect(stats.estimatedSavingsPct).toBeCloseTo(72, 10);
    });

    it('caps at the correct bounds for all-hits / all-misses', () => {
      cache.recordHit();
      cache.recordHit();
      expect(cache.getStats().estimatedSavingsPct).toBeCloseTo(90, 10);

      cache.reset();
      cache.recordMiss();
      cache.recordMiss();
      expect(cache.getStats().estimatedSavingsPct).toBe(0);
    });
  });

  describe('shouldAdjustBreakpoint', () => {
    it('returns false before 3 consecutive misses', () => {
      expect(cache.shouldAdjustBreakpoint()).toBe(false);
      cache.recordMiss();
      expect(cache.shouldAdjustBreakpoint()).toBe(false);
      cache.recordMiss();
      expect(cache.shouldAdjustBreakpoint()).toBe(false);
    });

    it('returns true after 3 consecutive misses', () => {
      cache.recordMiss();
      cache.recordMiss();
      cache.recordMiss();
      expect(cache.shouldAdjustBreakpoint()).toBe(true);
    });

    it('resets the miss streak on a hit', () => {
      cache.recordMiss();
      cache.recordMiss();
      cache.recordHit();
      expect(cache.shouldAdjustBreakpoint()).toBe(false);
      cache.recordMiss();
      cache.recordMiss();
      // Only 2 misses since the last hit → still false.
      expect(cache.shouldAdjustBreakpoint()).toBe(false);
      cache.recordMiss();
      expect(cache.shouldAdjustBreakpoint()).toBe(true);
    });

    it('stays true while additional misses accumulate past threshold', () => {
      cache.recordMiss();
      cache.recordMiss();
      cache.recordMiss();
      cache.recordMiss();
      cache.recordMiss();
      expect(cache.shouldAdjustBreakpoint()).toBe(true);
    });
  });

  describe('reset', () => {
    it('clears hit/miss counters, entries, and miss streak', () => {
      cache.recordHit('x');
      cache.recordMiss('y', 'system');
      cache.recordMiss('z', 'system');
      cache.recordMiss('w', 'system');
      expect(cache.shouldAdjustBreakpoint()).toBe(true);
      expect(cache.getEntries().size).toBeGreaterThan(0);

      cache.reset();

      const stats = cache.getStats();
      expect(stats).toEqual({
        hits: 0,
        misses: 0,
        hitRate: 0,
        estimatedSavingsPct: 0,
      });
      expect(cache.shouldAdjustBreakpoint()).toBe(false);
      expect(cache.getEntries().size).toBe(0);
    });
  });
});
