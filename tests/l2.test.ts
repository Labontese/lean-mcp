import { describe, it, expect, beforeEach } from 'vitest';
import { SemanticDedup } from '../src/layers/l2-semantic-dedup.js';
import { ObservabilityBus } from '../src/layers/l6-observability.js';

describe('L2 SemanticDedup', () => {
  let dedup: SemanticDedup;

  beforeEach(() => {
    // Lower the threshold for most tests so fuzzy behaviour is exercised.
    dedup = new SemanticDedup({ fuzzyThreshold: 0.5 });
  });

  describe('construction + config', () => {
    it('uses safe defaults when no config is passed', () => {
      const d = new SemanticDedup();
      const cfg = d.getConfig();
      expect(cfg.exactMatch).toBe(true);
      expect(cfg.fuzzyMatch).toBe(true);
      expect(cfg.fuzzyThreshold).toBe(0.97);
      expect(cfg.maxCacheSize).toBe(500);
    });

    it('merges partial config over defaults', () => {
      const d = new SemanticDedup({ fuzzyThreshold: 0.8 });
      const cfg = d.getConfig();
      expect(cfg.fuzzyThreshold).toBe(0.8);
      expect(cfg.exactMatch).toBe(true); // untouched default
    });

    it('clamps absurd threshold values into [0, 1]', () => {
      expect(new SemanticDedup({ fuzzyThreshold: -5 }).getConfig().fuzzyThreshold).toBe(0);
      expect(new SemanticDedup({ fuzzyThreshold: 42 }).getConfig().fuzzyThreshold).toBe(1);
    });
  });

  describe('exact-match detection', () => {
    it('flags identical strings as duplicates', () => {
      const a = 'The quick brown fox jumps over the lazy dog.';
      expect(dedup.isDuplicate(a, a)).toBe(true);
    });

    it('deduplicate collapses identical items and preserves order', () => {
      const result = dedup.deduplicate(['a', 'a', 'b']);
      expect(result.deduplicated).toEqual(['a', 'b']);
      expect(result.removedCount).toBe(1);
    });

    it('keeps the first occurrence, not the last', () => {
      const first = 'hello world version one';
      const dup = 'hello world version one';
      const result = dedup.deduplicate([first, 'middle item here', dup]);
      expect(result.deduplicated[0]).toBe(first);
      expect(result.deduplicated.length).toBe(2);
    });
  });

  describe('fuzzy-match detection', () => {
    it('flags near-identical strings at a low threshold', () => {
      // With 9-token inputs and one word differing, exactly 3 shingles
      // are affected out of 7 — so Jaccard ≈ 0.4. Use a threshold below
      // that to catch the near-duplicate.
      const d = new SemanticDedup({ fuzzyThreshold: 0.35 });
      const a = 'the quick brown fox jumps over the lazy dog';
      const b = 'the quick brown fox leaps over the lazy dog';
      expect(d.isDuplicate(a, b)).toBe(true);
    });

    it('does NOT flag completely different strings', () => {
      const a = 'machine learning models are trained on large datasets';
      const b = 'dogs bark loudly at squirrels in the park';
      expect(dedup.isDuplicate(a, b)).toBe(false);
    });

    it('high threshold (0.99) misses near-duplicates', () => {
      const d = new SemanticDedup({ fuzzyThreshold: 0.99 });
      const a = 'the quick brown fox jumps over the lazy dog today';
      const b = 'the quick brown fox leaps over the lazy dog today';
      expect(d.isDuplicate(a, b)).toBe(false);
    });

    it('low threshold (0.3) catches loosely similar text', () => {
      const d = new SemanticDedup({ fuzzyThreshold: 0.3 });
      const a = 'Claude is an AI assistant built by Anthropic for helpful conversations';
      const b = 'Claude is an AI assistant built by Anthropic to be helpful and honest';
      expect(d.isDuplicate(a, b)).toBe(true);
    });
  });

  describe('edge cases', () => {
    it('returns an empty list for empty input', () => {
      const result = dedup.deduplicate([]);
      expect(result).toEqual({
        original: [],
        deduplicated: [],
        removedCount: 0,
        estimatedTokensSaved: 0,
      });
    });

    it('returns a single-item list unchanged', () => {
      const result = dedup.deduplicate(['only one']);
      expect(result.deduplicated).toEqual(['only one']);
      expect(result.removedCount).toBe(0);
      expect(result.estimatedTokensSaved).toBe(0);
    });

    it('treats whitespace-only differences as duplicates in fuzzy mode', () => {
      const a = 'one two three four five';
      const b = '  one  two  three  four  five  ';
      expect(dedup.isDuplicate(a, b)).toBe(true);
    });
  });

  describe('estimatedTokensSaved', () => {
    it('is greater than zero when items are removed', () => {
      const item = 'This is a reasonably long string that should contribute real tokens.';
      const result = dedup.deduplicate([item, item, item]);
      expect(result.removedCount).toBe(2);
      expect(result.estimatedTokensSaved).toBeGreaterThan(0);
    });

    it('is zero when nothing is removed', () => {
      const result = dedup.deduplicate([
        'alpha beta gamma',
        'wholly different content entirely',
      ]);
      expect(result.removedCount).toBe(0);
      expect(result.estimatedTokensSaved).toBe(0);
    });
  });

  describe('clearCache', () => {
    it('resets internal state without changing config', () => {
      dedup.deduplicate(['some content to remember']);
      dedup.clearCache();
      // After clearing, the exact-same input should still be deduped
      // within a single call (call-local set), but no state should
      // persist between calls — verified indirectly by config staying
      // intact.
      expect(dedup.getConfig().fuzzyThreshold).toBe(0.5);
      // Running dedup again on fresh inputs should not throw and should
      // behave like a cold start.
      const r = dedup.deduplicate(['fresh one', 'fresh two']);
      expect(r.deduplicated).toHaveLength(2);
    });
  });

  describe('observability integration', () => {
    it('emits a single l2.deduplicate event per call', () => {
      const bus = new ObservabilityBus();
      const d = new SemanticDedup({ fuzzyThreshold: 0.97 }, bus);
      d.deduplicate(['foo', 'foo', 'bar']);
      const events = bus.getRecentEvents();
      expect(events).toHaveLength(1);
      expect(events[0].layer).toBe('l2');
      expect(events[0].operation).toBe('deduplicate');
      expect(typeof events[0].latencyMs).toBe('number');
      expect(events[0].tokensBefore).toBeGreaterThanOrEqual(0);
      expect(events[0].tokensAfter).toBeGreaterThanOrEqual(0);
    });
  });

  describe('fuzzyMatch disabled', () => {
    it('only exact duplicates are removed when fuzzyMatch=false', () => {
      const d = new SemanticDedup({ fuzzyMatch: false, fuzzyThreshold: 0.1 });
      const a = 'the quick brown fox jumps over the lazy dog';
      const b = 'the quick brown fox leaps over the lazy dog';
      const result = d.deduplicate([a, b, a]);
      // b survives (not exact match); only the second `a` is removed.
      expect(result.deduplicated).toEqual([a, b]);
      expect(result.removedCount).toBe(1);
    });
  });
});
