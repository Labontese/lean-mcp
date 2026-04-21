import { describe, it, expect } from 'vitest';
import {
  AnthropicCompressor,
  ContextCompression,
} from '../src/layers/l3-compression.js';
import { ObservabilityBus } from '../src/layers/l6-observability.js';
import type { ConversationTurn } from '../src/types/index.js';

function turn(
  role: 'user' | 'assistant',
  content: string,
  tokenEstimate: number,
): ConversationTurn {
  return { role, content, tokenEstimate };
}

/**
 * Fake messages client shaped like the subset of the Anthropic SDK that
 * `AnthropicCompressor.summarize()` actually uses. Keeps tests hermetic
 * and avoids any real network traffic.
 */
function fakeClient(text: string, capture?: { lastCall?: unknown }) {
  return {
    messages: {
      create: async (params: unknown) => {
        if (capture) {
          capture.lastCall = params;
        }
        return {
          content: [{ type: 'text' as const, text }],
        };
      },
    },
  };
}

describe('L3 compressAsync', () => {
  it('falls back to the placeholder when no client is wired up', async () => {
    // Explicit null override → no env lookup, no live client.
    const compressor = new AnthropicCompressor(null);
    const l3 = new ContextCompression(
      { triggerTokens: 100, keepRecentTurns: 2 },
      undefined,
      compressor,
    );
    const turns: ConversationTurn[] = [
      turn('user', 'old-1', 50),
      turn('assistant', 'old-2', 50),
      turn('user', 'old-3', 50),
      turn('assistant', 'keep-1', 10),
      turn('user', 'keep-2', 10),
    ];
    const result = await l3.compressAsync(turns);
    expect(result.wasTriggered).toBe(true);
    const summary = result.compressed[0];
    expect(summary.role).toBe('assistant');
    // Placeholder is structured and mentions the older-turn count.
    expect(summary.content).toContain('Compressed summary of 3 turns');
    expect(l3.hasLiveCompressor()).toBe(false);
  });

  it('calls the injected Haiku client and uses the returned text', async () => {
    const capture: { lastCall?: unknown } = {};
    const compressor = new AnthropicCompressor(
      fakeClient('Decisions: X. Code: Y. Files: /a.ts.', capture),
    );
    const l3 = new ContextCompression(
      {
        triggerTokens: 100,
        keepRecentTurns: 2,
        model: 'claude-haiku-4-5-20251001',
      },
      undefined,
      compressor,
    );
    const turns: ConversationTurn[] = [
      turn('user', 'old-1', 50),
      turn('assistant', 'old-2', 50),
      turn('user', 'old-3', 50),
      turn('assistant', 'keep-1', 10),
      turn('user', 'keep-2', 10),
    ];
    const result = await l3.compressAsync(turns);
    expect(l3.hasLiveCompressor()).toBe(true);
    expect(result.wasTriggered).toBe(true);
    // Summary now uses the model's response verbatim.
    expect(result.compressed[0].content).toBe(
      'Decisions: X. Code: Y. Files: /a.ts.',
    );
    // Verify the model/system/turns were threaded through correctly.
    const call = capture.lastCall as {
      model: string;
      system?: string;
      messages: Array<{ role: string; content: string }>;
    };
    expect(call.model).toBe('claude-haiku-4-5-20251001');
    expect(call.system).toContain('context compressor');
    expect(call.messages[0].content).toContain('old-1');
    expect(call.messages[0].content).toContain('old-3');
    // The kept tail must not leak into the summarisation prompt.
    expect(call.messages[0].content).not.toContain('keep-1');
    expect(call.messages[0].content).not.toContain('keep-2');
  });

  it('emits an observability event with mode=async and the live flag', async () => {
    const bus = new ObservabilityBus();
    const compressor = new AnthropicCompressor(fakeClient('short summary'));
    const l3 = new ContextCompression(
      { triggerTokens: 100, keepRecentTurns: 2 },
      bus,
      compressor,
    );
    const turns: ConversationTurn[] = [
      turn('user', 'a', 100),
      turn('assistant', 'b', 100),
      turn('user', 'c', 100),
      turn('assistant', 'keep-1', 10),
      turn('user', 'keep-2', 10),
    ];
    await l3.compressAsync(turns);
    const events = bus.getRecentEvents();
    expect(events.length).toBe(1);
    expect(events[0].layer).toBe('l3');
    expect(events[0].operation).toBe('compress');
    expect((events[0].metadata as Record<string, unknown>).mode).toBe('async');
    expect((events[0].metadata as Record<string, unknown>).live).toBe(true);
    expect(events[0].tokensAfter).toBeLessThan(events[0].tokensBefore!);
  });

  it('is a no-op under threshold even with a live client', async () => {
    const compressor = new AnthropicCompressor(fakeClient('should not run'));
    const l3 = new ContextCompression(
      { triggerTokens: 10_000, keepRecentTurns: 2 },
      undefined,
      compressor,
    );
    const turns: ConversationTurn[] = [
      turn('user', 'a', 10),
      turn('assistant', 'b', 10),
    ];
    const result = await l3.compressAsync(turns);
    expect(result.wasTriggered).toBe(false);
    expect(result.compressed).toBe(result.original);
  });
});
