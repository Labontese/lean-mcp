import { describe, it, expect, beforeEach } from 'vitest';
import { ModelRouter } from '../src/layers/l5-model-router.js';
import { ObservabilityBus } from '../src/layers/l6-observability.js';

const LONG_PROMPT = 'x '.repeat(1200); // ~2400 chars, no keywords
const CODE_BLOCK = '```ts\nconst a = 1;\n```';

describe('L5 ModelRouter', () => {
  let router: ModelRouter;

  beforeEach(() => {
    router = new ModelRouter();
  });

  describe('route — basic classification', () => {
    it('routes a short format-only prompt to haiku', () => {
      const r = router.route('Please format this JSON.');
      expect(r.tier).toBe('haiku');
      expect(r.modelId).toBe('claude-haiku-4-5-20251001');
    });

    it('routes a prompt containing "rename" to haiku', () => {
      const r = router.route('Can you rename this variable to userId?');
      expect(r.tier).toBe('haiku');
    });

    it('routes a prompt containing "refactor" to opus', () => {
      const r = router.route('Refactor this function to use async/await.');
      expect(r.tier).toBe('opus');
      expect(r.modelId).toBe('claude-opus-4-7');
    });

    it('routes a long architectural prompt to opus', () => {
      const r = router.route(
        'Design the overall architecture for a new billing subsystem that integrates with Stripe and supports multi-tenant invoicing.',
      );
      expect(r.tier).toBe('opus');
    });

    it('routes a normal-length code prompt to sonnet (default)', () => {
      const r = router.route(
        'Write a function that takes an array of numbers and returns their sum.',
      );
      expect(r.tier).toBe('sonnet');
      expect(r.modelId).toBe('claude-sonnet-4-6');
    });

    it('routes a very long prompt (>2000 chars) to opus even without keywords', () => {
      const r = router.route(LONG_PROMPT);
      expect(r.tier).toBe('opus');
    });

    it('routes a prompt with multiple code blocks to opus', () => {
      const prompt = `Here is file one:\n${CODE_BLOCK}\nAnd file two:\n${CODE_BLOCK}\nAnd file three:\n${CODE_BLOCK}`;
      const r = router.route(prompt);
      expect(r.tier).toBe('opus');
    });
  });

  describe('getModelId', () => {
    it('returns the correct model-ID for each tier', () => {
      expect(router.getModelId('haiku')).toBe('claude-haiku-4-5-20251001');
      expect(router.getModelId('sonnet')).toBe('claude-sonnet-4-6');
      expect(router.getModelId('opus')).toBe('claude-opus-4-7');
    });
  });

  describe('ModelRoutingResult shape', () => {
    it('always returns confidenceScore between 0 and 1', () => {
      const prompts = [
        'format this',
        'refactor the system',
        'hello world',
        LONG_PROMPT,
        'Write a regular utility function for me.',
      ];
      for (const p of prompts) {
        const r = router.route(p);
        expect(r.confidenceScore).toBeGreaterThanOrEqual(0);
        expect(r.confidenceScore).toBeLessThanOrEqual(1);
      }
    });

    it('always returns estimatedCostUsd > 0', () => {
      const r1 = router.route('hi');
      const r2 = router.route(LONG_PROMPT);
      expect(r1.estimatedCostUsd).toBeGreaterThan(0);
      expect(r2.estimatedCostUsd).toBeGreaterThan(0);
      // Long prompt on Opus should cost more than tiny prompt on Haiku.
      expect(r2.estimatedCostUsd).toBeGreaterThan(r1.estimatedCostUsd);
    });

    it('returns a non-empty reasoning string', () => {
      const r = router.route('Refactor the payment service.');
      expect(typeof r.reasoning).toBe('string');
      expect(r.reasoning.length).toBeGreaterThan(0);
    });
  });

  describe('getStats', () => {
    it('counts routes per tier correctly', () => {
      router.route('format this');          // haiku
      router.route('rename variable');      // haiku
      router.route('Refactor the auth');    // opus
      router.route('Write a small util that adds two numbers together for me please.'); // sonnet

      const s = router.getStats();
      expect(s.haiku).toBe(2);
      expect(s.sonnet).toBe(1);
      expect(s.opus).toBe(1);
      expect(s.total).toBe(4);
    });

    it('starts at zero for a fresh router', () => {
      const s = router.getStats();
      expect(s).toEqual({ haiku: 0, sonnet: 0, opus: 0, total: 0 });
    });
  });

  describe('custom config', () => {
    it('respects custom opusKeywords', () => {
      const custom = new ModelRouter({ opusKeywords: ['firenado'] });
      const r = custom.route('Spawn a firenado please.');
      expect(r.tier).toBe('opus');
    });

    it('respects custom haikuKeywords', () => {
      const custom = new ModelRouter({ haikuKeywords: ['gigglesnort'] });
      const r = custom.route('Gigglesnort this sentence for me.');
      expect(r.tier).toBe('haiku');
    });

    it('falls back to sonnet when enableOpus is false', () => {
      const custom = new ModelRouter({ enableOpus: false });
      // Would normally be opus because of 'refactor'
      const r1 = custom.route('Refactor the billing module.');
      expect(r1.tier).not.toBe('opus');
      expect(r1.tier).toBe('sonnet');

      // Also for very-long-prompt trigger
      const r2 = custom.route(LONG_PROMPT);
      expect(r2.tier).not.toBe('opus');
    });

    it('falls back to sonnet when enableHaiku is false', () => {
      const custom = new ModelRouter({ enableHaiku: false });
      const r = custom.route('Please format this code.');
      expect(r.tier).not.toBe('haiku');
      expect(r.tier).toBe('sonnet');
    });

    it('getConfig returns a defensive copy', () => {
      const cfg = router.getConfig();
      cfg.opusKeywords.push('mutated');
      // Internal state must be unchanged
      const cfg2 = router.getConfig();
      expect(cfg2.opusKeywords).not.toContain('mutated');
    });
  });

  describe('observability integration', () => {
    it('emits an l5 route event with tier metadata', () => {
      const bus = new ObservabilityBus();
      const r = new ModelRouter({}, bus);
      r.route('Refactor the auth module.');

      const events = bus.getRecentEvents();
      const l5 = events.filter((e) => e.layer === 'l5');
      expect(l5.length).toBe(1);
      expect(l5[0].operation).toBe('route');
      expect(l5[0].metadata).toMatchObject({
        tier: 'opus',
        modelId: 'claude-opus-4-7',
      });
      expect(typeof (l5[0].metadata as { confidenceScore: number }).confidenceScore).toBe('number');
    });
  });

  describe('reset', () => {
    it('zeros out the per-tier counters', () => {
      router.route('format this');
      router.route('refactor the system');
      expect(router.getStats().total).toBeGreaterThan(0);

      router.reset();
      expect(router.getStats()).toEqual({
        haiku: 0,
        sonnet: 0,
        opus: 0,
        total: 0,
      });
    });
  });
});
