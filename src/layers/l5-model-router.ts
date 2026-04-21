// l5-model-router.ts
import type {
  ModelRoutingResult,
  ModelTier,
  RouterConfig,
} from '../types/index.js';
import type { ObservabilityBus } from './l6-observability.js';

/**
 * ModelRouter — L5
 *
 * Classifies an incoming prompt into a model tier (haiku / sonnet / opus)
 * using a cheap, deterministic heuristic:
 *
 *   1. Keyword match — 'refactor', 'architecture' … → Opus
 *                      'format',   'rename'       … → Haiku
 *   2. Length signal — very long prompts (>2000 chars) are almost always
 *      complex → Opus; short prompts (<200 chars) with no code are
 *      almost always trivial → Haiku.
 *   3. Code density  — multiple fenced code blocks suggest multi-file /
 *      multi-step reasoning → Opus.
 *   4. Fallback      — `config.defaultTier` (normally 'sonnet').
 *
 * NOTE (Fas 3): Actual Haiku-as-classifier calls are not wired yet. The
 * spec (~50 tokens per decision, ≈ $0.00005) will move this layer from
 * heuristic → model-driven. Today we ship the heuristic path, emit
 * observability events, and keep the API stable so Fas 4 can swap the
 * internals without breaking call-sites.
 *
 * TODO (Fas 4): Replace `classify()` with an Anthropic Messages call
 * against claude-haiku-4-5 using a pinned system prompt. The heuristic
 * path should remain as a fallback when the API is unavailable.
 */
export class ModelRouter {
  /** Rough 4-chars-per-token heuristic Anthropic documents for English. */
  private static readonly CHARS_PER_TOKEN = 4;

  /**
   * Prompts shorter than this (without code) lean toward Haiku. Kept
   * aggressive on purpose — most natural code prompts are 60–200 chars
   * and should land on Sonnet. Only extremely short one-liners ("fix
   * this typo", "format this") qualify as trivial-without-keyword.
   */
  private static readonly SHORT_PROMPT_CHARS = 60;

  /** Prompts longer than this are almost always complex → Opus. */
  private static readonly LONG_PROMPT_CHARS = 2000;

  /** Minimum fenced code-block count that signals multi-file scope. */
  private static readonly MULTI_CODE_BLOCK_THRESHOLD = 2;

  /**
   * Per-tier model IDs. Kept as a static map so tests and integrations
   * can assert exact identifiers without reaching into instance state.
   */
  private static readonly MODEL_IDS: Record<ModelTier, string> = {
    haiku: 'claude-haiku-4-5-20251001',
    sonnet: 'claude-sonnet-4-6',
    opus: 'claude-opus-4-7',
  };

  /**
   * Per-tier input price in USD per 1M tokens. We use the input price
   * as the cost-estimate anchor — output price varies much more with
   * task shape, so the router reports input-side cost only. If we later
   * want a blended estimate we can add an output multiplier here.
   */
  private static readonly PRICE_PER_MTOK: Record<ModelTier, number> = {
    haiku: 1,
    sonnet: 3,
    opus: 15,
  };

  private static readonly DEFAULTS: RouterConfig = {
    defaultTier: 'sonnet',
    enableHaiku: true,
    enableOpus: true,
    opusKeywords: [
      'architecture',
      'refactor',
      'design',
      'system',
      'migrate',
      'security',
      'performance',
      'multi-file',
      'complex',
    ],
    haikuKeywords: [
      'format',
      'rename',
      'indent',
      'typo',
      'spelling',
      'list',
      'summarize',
      'translate',
      'convert',
    ],
  };

  private readonly config: RouterConfig;
  private readonly bus?: ObservabilityBus;

  private stats: Record<ModelTier, number> = {
    haiku: 0,
    sonnet: 0,
    opus: 0,
  };

  constructor(config: Partial<RouterConfig> = {}, bus?: ObservabilityBus) {
    this.config = {
      ...ModelRouter.DEFAULTS,
      ...config,
      // Arrays must be copied so callers can't mutate our internal state.
      opusKeywords: [
        ...(config.opusKeywords ?? ModelRouter.DEFAULTS.opusKeywords),
      ],
      haikuKeywords: [
        ...(config.haikuKeywords ?? ModelRouter.DEFAULTS.haikuKeywords),
      ],
    };
    this.bus = bus;
  }

  /**
   * Classify `prompt` and return the chosen tier + metadata. Pure
   * heuristic today; see the class docstring for the Fas 4 upgrade path.
   */
  route(prompt: string): ModelRoutingResult {
    const normalized = prompt.toLowerCase();
    const length = prompt.length;
    const codeBlockCount = this.countCodeBlocks(prompt);

    // --- Decide raw tier --------------------------------------------
    let tier: ModelTier = this.config.defaultTier;
    let reasoning = `Default tier (${this.config.defaultTier}) — no heuristic triggered`;
    let confidenceScore = 0.5;

    const opusKeyword = this.matchKeyword(normalized, this.config.opusKeywords);
    const haikuKeyword = this.matchKeyword(
      normalized,
      this.config.haikuKeywords,
    );
    const isLong = length > ModelRouter.LONG_PROMPT_CHARS;
    const hasManyCodeBlocks =
      codeBlockCount >= ModelRouter.MULTI_CODE_BLOCK_THRESHOLD;
    const isShortNoCode =
      length < ModelRouter.SHORT_PROMPT_CHARS && codeBlockCount === 0;

    // Opus triggers first — complex work must never be silently
    // downgraded to a cheaper tier.
    if (opusKeyword !== null) {
      tier = 'opus';
      reasoning = `Opus keyword match: "${opusKeyword}"`;
      confidenceScore = 0.9;
    } else if (isLong) {
      tier = 'opus';
      reasoning = `Long prompt (${length} chars > ${ModelRouter.LONG_PROMPT_CHARS}) → complex task`;
      confidenceScore = 0.85;
    } else if (hasManyCodeBlocks) {
      tier = 'opus';
      reasoning = `Multiple code blocks (${codeBlockCount}) suggest multi-file scope`;
      confidenceScore = 0.8;
    } else if (haikuKeyword !== null && !hasManyCodeBlocks) {
      tier = 'haiku';
      reasoning = `Haiku keyword match: "${haikuKeyword}"`;
      confidenceScore = 0.85;
    } else if (isShortNoCode) {
      tier = 'haiku';
      reasoning = `Short prompt (${length} chars < ${ModelRouter.SHORT_PROMPT_CHARS}) with no code blocks → trivial task`;
      confidenceScore = 0.75;
    }

    // --- Apply enable flags -----------------------------------------
    // A disabled tier must never be returned. Fall back to default,
    // and if the default itself is disabled, fall back to sonnet which
    // is always available (middle tier, never gated).
    if (tier === 'opus' && !this.config.enableOpus) {
      tier = this.safeFallbackTier();
      reasoning = `${reasoning} — but opus is disabled, falling back to ${tier}`;
      confidenceScore = Math.min(confidenceScore, 0.5);
    }
    if (tier === 'haiku' && !this.config.enableHaiku) {
      tier = this.safeFallbackTier();
      reasoning = `${reasoning} — but haiku is disabled, falling back to ${tier}`;
      confidenceScore = Math.min(confidenceScore, 0.5);
    }

    const modelId = ModelRouter.MODEL_IDS[tier];
    const estimatedCostUsd = this.estimateCost(tier, length);

    this.stats[tier] += 1;

    this.bus?.emit({
      layer: 'l5',
      operation: 'route',
      metadata: {
        tier,
        modelId,
        confidenceScore,
      },
    });

    return {
      tier,
      modelId,
      reasoning,
      confidenceScore,
      estimatedCostUsd,
    };
  }

  /** Map a tier to its pinned model identifier. */
  getModelId(tier: ModelTier): string {
    return ModelRouter.MODEL_IDS[tier];
  }

  /** Return a defensive copy of the effective config. */
  getConfig(): RouterConfig {
    return {
      ...this.config,
      opusKeywords: [...this.config.opusKeywords],
      haikuKeywords: [...this.config.haikuKeywords],
    };
  }

  /** Return per-tier routing counters plus the grand total. */
  getStats(): { haiku: number; sonnet: number; opus: number; total: number } {
    return {
      haiku: this.stats.haiku,
      sonnet: this.stats.sonnet,
      opus: this.stats.opus,
      total: this.stats.haiku + this.stats.sonnet + this.stats.opus,
    };
  }

  /** Reset per-tier counters — primarily for tests. */
  reset(): void {
    this.stats = { haiku: 0, sonnet: 0, opus: 0 };
  }

  // --- private helpers ----------------------------------------------

  /**
   * Find the first keyword from `keywords` that appears in the
   * already-lowercased prompt. Whole-substring match so "refactoring"
   * still triggers the "refactor" keyword.
   */
  private matchKeyword(
    lowerPrompt: string,
    keywords: readonly string[],
  ): string | null {
    for (const kw of keywords) {
      if (kw.length === 0) continue;
      if (lowerPrompt.includes(kw.toLowerCase())) return kw;
    }
    return null;
  }

  /**
   * Count the number of fenced code blocks (``` markers) in the prompt.
   * A block requires an opening and closing fence so we divide by 2.
   */
  private countCodeBlocks(prompt: string): number {
    const fenceCount = prompt.split('```').length - 1;
    return Math.floor(fenceCount / 2);
  }

  /**
   * Return a tier guaranteed to be enabled. Sonnet is the structural
   * safety net — it is always available and never gated by config.
   */
  private safeFallbackTier(): ModelTier {
    if (
      this.config.defaultTier === 'opus' &&
      this.config.enableOpus === false
    ) {
      return 'sonnet';
    }
    if (
      this.config.defaultTier === 'haiku' &&
      this.config.enableHaiku === false
    ) {
      return 'sonnet';
    }
    return this.config.defaultTier;
  }

  /**
   * Rough input-side cost estimate for `prompt` at `tier`. Uses the
   * documented 4-chars-per-token heuristic; output tokens are ignored.
   */
  private estimateCost(tier: ModelTier, promptChars: number): number {
    const tokens = Math.max(1, Math.ceil(promptChars / ModelRouter.CHARS_PER_TOKEN));
    const pricePerMtok = ModelRouter.PRICE_PER_MTOK[tier];
    return (tokens / 1_000_000) * pricePerMtok;
  }
}
