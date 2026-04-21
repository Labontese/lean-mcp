// l3-compression.ts
import Anthropic from '@anthropic-ai/sdk';
import type {
  CompressionConfig,
  CompressionResult,
  ConversationTurn,
} from '../types/index.js';
import type { ObservabilityBus } from './l6-observability.js';

/**
 * Minimal structural interface for the Anthropic messages client. Narrowing
 * the dependency to just the call we use lets tests inject a fake without
 * dragging the full SDK surface into the type-check.
 */
export interface AnthropicMessagesClient {
  messages: {
    create(params: {
      model: string;
      max_tokens: number;
      system?: string;
      messages: Array<{ role: 'user' | 'assistant'; content: string }>;
    }): Promise<{
      content: Array<{ type: string; text?: string }>;
    }>;
  };
}

/**
 * AnthropicCompressor — internal helper that performs the real Haiku call.
 *
 * Constructed lazily: if `ANTHROPIC_API_KEY` isn't set at instantiation,
 * the client stays `null` and callers must fall back to the deterministic
 * placeholder. This lets the server run in environments without API
 * credentials (dev, CI, tests) without crashing.
 */
export class AnthropicCompressor {
  private client: AnthropicMessagesClient | null = null;

  /**
   * @param clientOverride Inject a fake client (used in tests). When omitted,
   *   we look at `ANTHROPIC_API_KEY` and construct a real Anthropic client.
   */
  constructor(clientOverride?: AnthropicMessagesClient | null) {
    if (clientOverride !== undefined) {
      this.client = clientOverride;
      return;
    }
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (apiKey) {
      this.client = new Anthropic({ apiKey }) as unknown as AnthropicMessagesClient;
    }
  }

  /** True iff a live client is wired up (either env-key or injected). */
  isAvailable(): boolean {
    return this.client !== null;
  }

  /**
   * Summarise `turns` using the given model. Returns the placeholder text
   * when no client is configured so callers get a consistent return shape.
   */
  async summarize(turns: ConversationTurn[], model: string): Promise<string> {
    const totalTokens = turns.reduce((sum, t) => sum + t.tokenEstimate, 0);
    if (!this.client) {
      return placeholderSummary(turns.length, totalTokens);
    }

    const turnText = turns
      .map((t) => `${t.role}: ${t.content}`)
      .join('\n\n');

    const response = await this.client.messages.create({
      model,
      max_tokens: 1024,
      system:
        'You are a context compressor. Summarize the conversation preserving: decisions made, code written, file paths mentioned, errors encountered. Be extremely concise.',
      messages: [
        {
          role: 'user',
          content: `Compress this conversation history:\n\n${turnText}`,
        },
      ],
    });

    const first = response.content[0];
    if (first && first.type === 'text' && typeof first.text === 'string') {
      return first.text;
    }
    return '[compression failed]';
  }
}

/** Deterministic placeholder used when no live client is available. */
function placeholderSummary(turnCount: number, tokensBefore: number): string {
  return `[Compressed summary of ${turnCount} turns — ${tokensBefore} tokens → ~${Math.floor(tokensBefore * 0.15)} tokens]`;
}

/**
 * ContextCompression — L3
 *
 * Compresses older conversation turns to free up context window once the
 * running history exceeds a configurable token threshold. The most recent
 * `keepRecentTurns` turns stay intact (the active working set) while
 * older turns are folded into a single synthetic "summary" turn.
 *
 * Two entry points:
 *  - `compress()` — sync, always uses the deterministic placeholder. Kept
 *    for backward-compat with the existing test suite and for callers that
 *    don't want to block on a network round-trip.
 *  - `compressAsync()` — async, uses `AnthropicCompressor` to call Haiku
 *    when `ANTHROPIC_API_KEY` is configured. Falls back to the same
 *    placeholder when no key is present, so behaviour is stable either way.
 *
 * Pricing note: Haiku-compressing ~10 turns runs <$0.01 — the break-even
 * vs. carrying the raw history forward is typically one or two turns.
 */
export class ContextCompression {
  private static readonly DEFAULT_CONFIG: CompressionConfig = {
    triggerTokens: 8000,
    keepRecentTurns: 4,
    model: 'claude-haiku-4-5-20251001',
  };

  private readonly config: CompressionConfig;
  private readonly bus?: ObservabilityBus;
  private readonly compressor: AnthropicCompressor;

  constructor(
    config?: Partial<CompressionConfig>,
    bus?: ObservabilityBus,
    compressor?: AnthropicCompressor,
  ) {
    this.config = {
      ...ContextCompression.DEFAULT_CONFIG,
      ...(config ?? {}),
    };
    this.bus = bus;
    this.compressor = compressor ?? new AnthropicCompressor();
  }

  /**
   * Return true when the aggregate token estimate of `turns` exceeds the
   * configured trigger threshold. Empty / under-threshold histories are
   * left alone.
   */
  shouldCompress(turns: ConversationTurn[]): boolean {
    return this.estimateTokens(turns) > this.config.triggerTokens;
  }

  /**
   * True when a live Haiku client is wired up — callers can use this to
   * decide whether to prefer `compressAsync()` over `compress()`.
   */
  hasLiveCompressor(): boolean {
    return this.compressor.isAvailable();
  }

  /**
   * Synchronous compression using the deterministic placeholder summary.
   * Kept stable for the existing test suite and for callers that can't
   * await a network call.
   */
  compress(turns: ConversationTurn[]): CompressionResult {
    return this.runCompression(turns, (older, tokensBefore) => {
      const content = placeholderSummary(older.length, tokensBefore);
      return {
        role: 'assistant',
        content,
        tokenEstimate: content.length / 4,
      };
    });
  }

  /**
   * Async compression that calls Haiku via `AnthropicCompressor` when a
   * live client is configured. Falls back to the placeholder when no key
   * is present so callers get the same return shape either way.
   */
  async compressAsync(turns: ConversationTurn[]): Promise<CompressionResult> {
    const start = Date.now();
    const tokensBefore = this.estimateTokens(turns);

    if (turns.length === 0 || !this.shouldCompress(turns)) {
      return noop(turns, tokensBefore);
    }

    if (turns.length <= this.config.keepRecentTurns) {
      return noop(turns, tokensBefore);
    }

    const splitIdx = turns.length - this.config.keepRecentTurns;
    const olderTurns = turns.slice(0, splitIdx);
    const recentTurns = turns.slice(splitIdx);

    const summaryText = await this.compressor.summarize(
      olderTurns,
      this.config.model,
    );
    const summaryTurn: ConversationTurn = {
      role: 'assistant',
      content: summaryText,
      tokenEstimate: summaryText.length / 4,
    };

    const compressed: ConversationTurn[] = [summaryTurn, ...recentTurns];
    const tokensAfter = this.estimateTokens(compressed);
    const reductionPct =
      tokensBefore === 0
        ? 0
        : ((tokensBefore - tokensAfter) / tokensBefore) * 100;

    const latencyMs = Date.now() - start;
    if (this.bus) {
      this.bus.emit({
        layer: 'l3',
        operation: 'compress',
        tokensBefore,
        tokensAfter,
        latencyMs,
        metadata: {
          olderTurnCount: olderTurns.length,
          recentTurnCount: recentTurns.length,
          model: this.config.model,
          live: this.compressor.isAvailable(),
          mode: 'async',
        },
      });
    }

    return {
      original: turns,
      compressed,
      tokensBefore,
      tokensAfter,
      reductionPct,
      wasTriggered: true,
    };
  }

  /** Sum the `tokenEstimate` of every turn. */
  estimateTokens(turns: ConversationTurn[]): number {
    let total = 0;
    for (const t of turns) {
      total += t.tokenEstimate;
    }
    return total;
  }

  /** Return a shallow copy of the active configuration. */
  getConfig(): CompressionConfig {
    return { ...this.config };
  }

  /**
   * Shared shape for the sync path: computes splits, calls the provided
   * summariser (which must be synchronous here), emits observability, and
   * returns the result.
   */
  private runCompression(
    turns: ConversationTurn[],
    summarise: (
      older: ConversationTurn[],
      tokensBefore: number,
    ) => ConversationTurn,
  ): CompressionResult {
    const start = Date.now();
    const tokensBefore = this.estimateTokens(turns);

    if (turns.length === 0 || !this.shouldCompress(turns)) {
      return noop(turns, tokensBefore);
    }

    if (turns.length <= this.config.keepRecentTurns) {
      return noop(turns, tokensBefore);
    }

    const splitIdx = turns.length - this.config.keepRecentTurns;
    const olderTurns = turns.slice(0, splitIdx);
    const recentTurns = turns.slice(splitIdx);

    const olderTokens = this.estimateTokens(olderTurns);
    const summaryTurn = summarise(olderTurns, olderTokens);

    const compressed: ConversationTurn[] = [summaryTurn, ...recentTurns];
    const tokensAfter = this.estimateTokens(compressed);
    const reductionPct =
      tokensBefore === 0
        ? 0
        : ((tokensBefore - tokensAfter) / tokensBefore) * 100;

    const latencyMs = Date.now() - start;
    if (this.bus) {
      this.bus.emit({
        layer: 'l3',
        operation: 'compress',
        tokensBefore,
        tokensAfter,
        latencyMs,
        metadata: {
          olderTurnCount: olderTurns.length,
          recentTurnCount: recentTurns.length,
          model: this.config.model,
        },
      });
    }

    return {
      original: turns,
      compressed,
      tokensBefore,
      tokensAfter,
      reductionPct,
      wasTriggered: true,
    };
  }
}

function noop(
  turns: ConversationTurn[],
  tokens: number,
): CompressionResult {
  return {
    original: turns,
    compressed: turns,
    tokensBefore: tokens,
    tokensAfter: tokens,
    reductionPct: 0,
    wasTriggered: false,
  };
}
