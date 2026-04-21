import type { LazyRegistry } from '../layers/l1-lazy-registry.js';
import type { SemanticDedup } from '../layers/l2-semantic-dedup.js';
import type { ContextCompression } from '../layers/l3-compression.js';
import type { PromptCacheOrchestrator } from '../layers/l4-prompt-cache.js';
import type { ModelRouter } from '../layers/l5-model-router.js';
import type { ObservabilityBus } from '../layers/l6-observability.js';
import type { ConversationTurn } from '../types/index.js';

export const META_TOOLS = [
  {
    name: 'search_tools',
    description:
      'Search registered tools by name or description. Returns lightweight summaries (name + description) without full schemas to minimise input tokens.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Case-insensitive substring matched against tool name and description. Empty string returns all tools.',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'describe_tool',
    description: 'Return the full JSON schema and description for a specific tool by name.',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Exact tool name as returned by search_tools.',
        },
      },
      required: ['name'],
    },
  },
  {
    name: 'execute_tool',
    description: 'Execute a registered tool by name with the given arguments.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Exact tool name to execute.' },
        args: {
          type: 'object',
          description: 'Arguments object matching the tool\'s schema.',
          additionalProperties: true,
        },
      },
      required: ['name', 'args'],
    },
  },
  {
    name: 'get_cache_stats',
    description:
      'Return L4 prompt-cache statistics for the current session: hits, misses, hitRate, and estimatedSavingsPct vs. uncached requests.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'get_session_stats',
    description:
      'Return aggregated L6 observability statistics for the current session: total token reduction across all layers, per-layer breakdown, and the top operations by tokens saved.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'get_recent_events',
    description:
      'Return the most recent observability events emitted by any layer. Useful for debugging which optimisations fired for a given request.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: {
          type: 'number',
          description: 'Maximum number of events to return (default 50, max 1000).',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'deduplicate_context',
    description:
      'L2: Remove duplicated items from a list of context strings. Uses exact hash matching plus Jaccard similarity over word 3-shingles for near-duplicates. Returns the original list, the deduplicated list, removedCount, and an estimatedTokensSaved heuristic. Ordering is preserved and the first occurrence of each duplicate group wins.',
    inputSchema: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          description: 'Context items to deduplicate.',
          items: { type: 'string' },
        },
      },
      required: ['items'],
      additionalProperties: false,
    },
  },
  {
    name: 'compress_context',
    description:
      'L3: Compress an older conversation history by summarising turns before the active working set. Returns the full CompressionResult (tokensBefore/After, reductionPct, wasTriggered). No-op when total tokens are below the configured trigger.',
    inputSchema: {
      type: 'object',
      properties: {
        turns: {
          type: 'array',
          description: 'Ordered conversation history (oldest first).',
          items: {
            type: 'object',
            properties: {
              role: { type: 'string', enum: ['user', 'assistant'] },
              content: { type: 'string' },
              tokenEstimate: {
                type: 'number',
                description: 'Rough token estimate for the turn (content.length / 4).',
              },
            },
            required: ['role', 'content', 'tokenEstimate'],
            additionalProperties: false,
          },
        },
      },
      required: ['turns'],
      additionalProperties: false,
    },
  },
  {
    name: 'route_model',
    description:
      'L5: Classify a prompt and return the recommended model tier (haiku / sonnet / opus) plus the pinned model-ID, a short reasoning string, a confidence score in [0, 1], and a rough input-side cost estimate in USD. Heuristic-only in this release — no external API calls.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description: 'The user prompt (or prompt summary) to classify.',
        },
      },
      required: ['prompt'],
      additionalProperties: false,
    },
  },
] as const;

export type MetaToolName = (typeof META_TOOLS)[number]['name'];

export async function handleMetaTool(
  registry: LazyRegistry,
  name: string,
  args: Record<string, unknown>,
  promptCache?: PromptCacheOrchestrator,
  observability?: ObservabilityBus,
  compression?: ContextCompression,
  dedup?: SemanticDedup,
  modelRouter?: ModelRouter,
): Promise<unknown> {
  switch (name) {
    case 'search_tools': {
      const query = typeof args.query === 'string' ? args.query : '';
      return registry.search(query);
    }
    case 'describe_tool': {
      const toolName = typeof args.name === 'string' ? args.name : '';
      const def = registry.describe(toolName);
      if (!def) {
        throw new Error(`Unknown tool: ${toolName}`);
      }
      return {
        name: def.name,
        description: def.description,
        schema: def.schema,
      };
    }
    case 'execute_tool': {
      const toolName = typeof args.name === 'string' ? args.name : '';
      const toolArgs =
        args.args && typeof args.args === 'object'
          ? (args.args as Record<string, unknown>)
          : {};
      return await registry.execute(toolName, toolArgs);
    }
    case 'get_cache_stats': {
      if (!promptCache) {
        throw new Error('Prompt cache orchestrator is not available');
      }
      return promptCache.getStats();
    }
    case 'get_session_stats': {
      if (!observability) {
        throw new Error('Observability bus is not available');
      }
      return observability.getStats();
    }
    case 'get_recent_events': {
      if (!observability) {
        throw new Error('Observability bus is not available');
      }
      const limit =
        typeof args.limit === 'number' && Number.isFinite(args.limit)
          ? args.limit
          : undefined;
      return observability.getRecentEvents(limit);
    }
    case 'deduplicate_context': {
      if (!dedup) {
        throw new Error('Semantic dedup is not available');
      }
      const rawItems = Array.isArray(args.items) ? args.items : [];
      const items: string[] = rawItems.filter(
        (v): v is string => typeof v === 'string',
      );
      return dedup.deduplicate(items);
    }
    case 'compress_context': {
      if (!compression) {
        throw new Error('Context compression is not available');
      }
      const rawTurns = Array.isArray(args.turns) ? args.turns : [];
      const turns: ConversationTurn[] = rawTurns
        .filter(
          (t): t is ConversationTurn =>
            typeof t === 'object' &&
            t !== null &&
            (t as { role?: unknown }).role !== undefined &&
            typeof (t as { content?: unknown }).content === 'string' &&
            typeof (t as { tokenEstimate?: unknown }).tokenEstimate === 'number',
        )
        .map((t) => ({
          role: (t as ConversationTurn).role,
          content: (t as ConversationTurn).content,
          tokenEstimate: (t as ConversationTurn).tokenEstimate,
        }));
      // Prefer the real Haiku call when an API key is wired up; otherwise
      // the sync path returns the deterministic placeholder with the same
      // CompressionResult shape.
      if (compression.hasLiveCompressor()) {
        return await compression.compressAsync(turns);
      }
      return compression.compress(turns);
    }
    case 'route_model': {
      if (!modelRouter) {
        throw new Error('Model router is not available');
      }
      const prompt = typeof args.prompt === 'string' ? args.prompt : '';
      return modelRouter.route(prompt);
    }
    default:
      throw new Error(`Unknown meta-tool: ${name}`);
  }
}
