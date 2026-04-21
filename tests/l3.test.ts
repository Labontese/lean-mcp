import { describe, it, expect, beforeEach } from 'vitest';
import { ContextCompression } from '../src/layers/l3-compression.js';
import { ObservabilityBus } from '../src/layers/l6-observability.js';
import type { ConversationTurn } from '../src/types/index.js';

/** Build a turn with an explicit token estimate for deterministic tests. */
function turn(
  role: 'user' | 'assistant',
  content: string,
  tokenEstimate?: number,
): ConversationTurn {
  return {
    role,
    content,
    tokenEstimate: tokenEstimate ?? content.length / 4,
  };
}

/** N turns that together sum to `totalTokens`, split evenly. */
function turnsOfSize(n: number, totalTokens: number): ConversationTurn[] {
  const per = totalTokens / n;
  const out: ConversationTurn[] = [];
  for (let i = 0; i < n; i++) {
    out.push({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `turn-${i} ${'x'.repeat(Math.max(0, Math.floor(per * 4) - 8))}`,
      tokenEstimate: per,
    });
  }
  return out;
}

describe('L3 ContextCompression', () => {
  let l3: ContextCompression;

  beforeEach(() => {
    l3 = new ContextCompression();
  });

  describe('shouldCompress', () => {
    it('returns false when total tokens are under the trigger threshold', () => {
      const turns = turnsOfSize(6, 1000); // well under default 8000
      expect(l3.shouldCompress(turns)).toBe(false);
    });

    it('returns true when total tokens exceed the trigger threshold', () => {
      const turns = turnsOfSize(20, 12000); // well over default 8000
      expect(l3.shouldCompress(turns)).toBe(true);
    });

    it('returns false for an empty list', () => {
      expect(l3.shouldCompress([])).toBe(false);
    });

    it('respects a custom trigger threshold', () => {
      const tight = new ContextCompression({ triggerTokens: 500 });
      const turns = turnsOfSize(4, 1000);
      expect(tight.shouldCompress(turns)).toBe(true);
    });
  });

  describe('compress', () => {
    it('returns wasTriggered: false and leaves content unchanged under threshold', () => {
      const turns = turnsOfSize(6, 1000);
      const result = l3.compress(turns);
      expect(result.wasTriggered).toBe(false);
      expect(result.compressed).toBe(result.original);
      expect(result.reductionPct).toBe(0);
      expect(result.tokensBefore).toBe(result.tokensAfter);
    });

    it('returns wasTriggered: false for an empty list', () => {
      const result = l3.compress([]);
      expect(result.wasTriggered).toBe(false);
      expect(result.compressed).toEqual([]);
      expect(result.original).toEqual([]);
      expect(result.tokensBefore).toBe(0);
      expect(result.tokensAfter).toBe(0);
      expect(result.reductionPct).toBe(0);
    });

    it('keeps the most recent keepRecentTurns turns intact when triggered', () => {
      const l3Custom = new ContextCompression({
        triggerTokens: 100,
        keepRecentTurns: 3,
      });
      const turns: ConversationTurn[] = [
        turn('user', 'old-1', 50),
        turn('assistant', 'old-2', 50),
        turn('user', 'old-3', 50),
        turn('assistant', 'keep-1', 10),
        turn('user', 'keep-2', 10),
        turn('assistant', 'keep-3', 10),
      ];
      const result = l3Custom.compress(turns);
      expect(result.wasTriggered).toBe(true);
      // First item is the synthetic summary; remaining 3 are the kept tail.
      const tail = result.compressed.slice(-3);
      expect(tail).toEqual(turns.slice(-3));
    });

    it('creates a single synthetic summary turn for older turns', () => {
      const l3Custom = new ContextCompression({
        triggerTokens: 100,
        keepRecentTurns: 2,
      });
      const turns: ConversationTurn[] = [
        turn('user', 'old-1', 50),
        turn('assistant', 'old-2', 50),
        turn('user', 'old-3', 50),
        turn('assistant', 'keep-1', 10),
        turn('user', 'keep-2', 10),
      ];
      const result = l3Custom.compress(turns);
      expect(result.wasTriggered).toBe(true);
      // 1 summary + 2 kept = 3 turns total.
      expect(result.compressed.length).toBe(3);
      const summary = result.compressed[0];
      expect(summary.role).toBe('assistant');
      expect(summary.content).toContain('Compressed summary');
      expect(summary.content).toContain('3 turns'); // 3 older turns
    });

    it('reports reductionPct > 0 when compression triggered', () => {
      const l3Custom = new ContextCompression({
        triggerTokens: 100,
        keepRecentTurns: 2,
      });
      const turns: ConversationTurn[] = [
        turn('user', 'x'.repeat(400), 100),
        turn('assistant', 'x'.repeat(400), 100),
        turn('user', 'x'.repeat(400), 100),
        turn('assistant', 'x'.repeat(400), 100),
        turn('user', 'tail-a', 10),
        turn('assistant', 'tail-b', 10),
      ];
      const result = l3Custom.compress(turns);
      expect(result.wasTriggered).toBe(true);
      expect(result.reductionPct).toBeGreaterThan(0);
      expect(result.tokensAfter).toBeLessThan(result.tokensBefore);
    });

    it('reportss reductionPct === 0 when wasTriggered is false', () => {
      const turns = turnsOfSize(4, 500);
      const result = l3.compress(turns);
      expect(result.wasTriggered).toBe(false);
      expect(result.reductionPct).toBe(0);
    });

    it('does nothing when keepRecentTurns >= turn count', () => {
      const l3Custom = new ContextCompression({
        triggerTokens: 100,
        keepRecentTurns: 10,
      });
      const turns: ConversationTurn[] = [
        turn('user', 'a', 100),
        turn('assistant', 'b', 100),
        turn('user', 'c', 100),
      ];
      const result = l3Custom.compress(turns);
      // Would exceed threshold, but nothing to compress past the tail.
      expect(result.wasTriggered).toBe(false);
      expect(result.compressed).toBe(result.original);
      expect(result.reductionPct).toBe(0);
    });

    it('preserves all recent turns byref equality', () => {
      const l3Custom = new ContextCompression({
        triggerTokens: 100,
        keepRecentTurns: 2,
      });
      const recentA = turn('user', 'tail-a', 10);
      const recentB = turn('assistant', 'tail-b', 10);
      const turns: ConversationTurn[] = [
        turn('user', 'x', 100),
        turn('assistant', 'y', 100),
        turn('user', 'z', 100),
        recentA,
        recentB,
      ];
      const result = l3Custom.compress(turns);
      expect(result.wasTriggered).toBe(true);
      expect(result.compressed[result.compressed.length - 2]).toBe(recentA);
      expect(result.compressed[result.compressed.length - 1]).toBe(recentB);
    });
  });

  describe('estimateTokens', () => {
    it('sums the tokenEstimate across turns', () => {
      const turns: ConversationTurn[] = [
        turn('user', 'a', 10),
        turn('assistant', 'b', 25),
        turn('user', 'c', 7),
      ];
      expect(l3.estimateTokens(turns)).toBe(42);
    });

    it('returns 0 for an empty list', () => {
      expect(l3.estimateTokens([])).toBe(0);
    });
  });

  describe('getConfig', () => {
    it('returns defaults when no overrides are provided', () => {
      const cfg = l3.getConfig();
      expect(cfg.triggerTokens).toBe(8000);
      expect(cfg.keepRecentTurns).toBe(4);
      expect(cfg.model).toBe('claude-haiku-4-5-20251001');
    });

    it('merges partial overrides over defaults', () => {
      const custom = new ContextCompression({ triggerTokens: 2000 });
      const cfg = custom.getConfig();
      expect(cfg.triggerTokens).toBe(2000);
      expect(cfg.keepRecentTurns).toBe(4); // default preserved
      expect(cfg.model).toBe('claude-haiku-4-5-20251001'); // default preserved
    });

    it('returns a copy that cannot mutate internal state', () => {
      const cfg = l3.getConfig();
      cfg.triggerTokens = 1;
      expect(l3.getConfig().triggerTokens).toBe(8000);
    });
  });

  describe('observability', () => {
    it('emits an l3/compress event when compression triggers', () => {
      const bus = new ObservabilityBus();
      const l3Custom = new ContextCompression(
        { triggerTokens: 100, keepRecentTurns: 2 },
        bus,
      );
      const turns: ConversationTurn[] = [
        turn('user', 'a', 100),
        turn('assistant', 'b', 100),
        turn('user', 'c', 100),
        turn('assistant', 'keep-1', 10),
        turn('user', 'keep-2', 10),
      ];
      l3Custom.compress(turns);
      const events = bus.getRecentEvents();
      expect(events.length).toBe(1);
      expect(events[0].layer).toBe('l3');
      expect(events[0].operation).toBe('compress');
      expect(events[0].tokensBefore).toBeGreaterThan(0);
      expect(events[0].tokensAfter).toBeGreaterThan(0);
      expect(events[0].tokensAfter).toBeLessThan(events[0].tokensBefore!);
      expect(typeof events[0].latencyMs).toBe('number');
    });

    it('does not emit an event when compression is skipped', () => {
      const bus = new ObservabilityBus();
      const l3Custom = new ContextCompression(
        { triggerTokens: 100_000 },
        bus,
      );
      const turns = turnsOfSize(4, 500);
      l3Custom.compress(turns);
      expect(bus.getRecentEvents().length).toBe(0);
    });
  });
});
