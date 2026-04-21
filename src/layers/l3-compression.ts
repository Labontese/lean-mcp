// l3-compression.ts
import type {
  CompressionConfig,
  CompressionResult,
  ConversationTurn,
} from '../types/index.js';
import type { ObservabilityBus } from './l6-observability.js';

/**
 * ContextCompression — L3
 *
 * Compresses older conversation turns to free up context window once the
 * running history exceeds a configurable token threshold. The most recent
 * `keepRecentTurns` turns stay intact (the active working set) while
 * older turns are folded into a single synthetic "summary" turn.
 *
 * NOTE (Fas 2): Actual Haiku API calls are not wired yet. We generate a
 * deterministic placeholder summary that preserves the *structure* so
 * L6 observability, downstream consumers, and tests can exercise the full
 * pipeline. Replace the placeholder in `summariseTurns()` with a real
 * Anthropic SDK call in Fas 3.
 *
 * Pricing note (for Fas 3): Haiku-compressing ~10 turns should run
 * <$0.01 — the break-even vs. carrying the raw history forward across
 * subsequent requests is reached after one or two turns.
 */
export class ContextCompression {
  private static readonly DEFAULT_CONFIG: CompressionConfig = {
    triggerTokens: 8000,
    keepRecentTurns: 4,
    model: 'claude-haiku-4-5-20251001',
  };

  private readonly config: CompressionConfig;
  private readonly bus?: ObservabilityBus;

  constructor(config?: Partial<CompressionConfig>, bus?: ObservabilityBus) {
    this.config = {
      ...ContextCompression.DEFAULT_CONFIG,
      ...(config ?? {}),
    };
    this.bus = bus;
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
   * Compress the conversation if the trigger fires. Otherwise returns a
   * no-op result with `wasTriggered: false` and `compressed === original`.
   *
   * Compression strategy:
   *  - Keep the last `keepRecentTurns` turns fully intact.
   *  - Collapse everything older into a single synthetic assistant turn
   *    carrying a placeholder summary (TODO: real Haiku call in Fas 3).
   */
  compress(turns: ConversationTurn[]): CompressionResult {
    const start = Date.now();
    const tokensBefore = this.estimateTokens(turns);

    // Empty list or under-threshold → no-op.
    if (turns.length === 0 || !this.shouldCompress(turns)) {
      return {
        original: turns,
        compressed: turns,
        tokensBefore,
        tokensAfter: tokensBefore,
        reductionPct: 0,
        wasTriggered: false,
      };
    }

    // Not enough older turns to compress — bail out cleanly.
    if (turns.length <= this.config.keepRecentTurns) {
      return {
        original: turns,
        compressed: turns,
        tokensBefore,
        tokensAfter: tokensBefore,
        reductionPct: 0,
        wasTriggered: false,
      };
    }

    const splitIdx = turns.length - this.config.keepRecentTurns;
    const olderTurns = turns.slice(0, splitIdx);
    const recentTurns = turns.slice(splitIdx);

    const olderTokens = this.estimateTokens(olderTurns);
    const summaryTurn = this.summariseTurns(olderTurns, olderTokens);

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
   * Produce the synthetic summary turn. TODO(Fas 3): replace with a real
   * Haiku API call — the placeholder below is structurally identical so
   * downstream code doesn't need to change.
   */
  private summariseTurns(
    olderTurns: ConversationTurn[],
    tokensBefore: number,
  ): ConversationTurn {
    // TODO(Fas 3): Replace with actual Anthropic SDK call using
    // this.config.model. For now we emit a deterministic placeholder so
    // tests and observability can exercise the full pipeline.
    const content = `[Compressed summary of ${olderTurns.length} turns — ${tokensBefore} tokens → ${Math.ceil(olderTurns.length * 10)} tokens]`;
    return {
      role: 'assistant',
      content,
      tokenEstimate: content.length / 4,
    };
  }
}
