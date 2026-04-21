import type { LazyRegistry } from '../layers/l1-lazy-registry.js';
import type { PromptCacheOrchestrator } from '../layers/l4-prompt-cache.js';
import type { ObservabilityBus } from '../layers/l6-observability.js';

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
] as const;

export type MetaToolName = (typeof META_TOOLS)[number]['name'];

export async function handleMetaTool(
  registry: LazyRegistry,
  name: string,
  args: Record<string, unknown>,
  promptCache?: PromptCacheOrchestrator,
  observability?: ObservabilityBus,
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
    default:
      throw new Error(`Unknown meta-tool: ${name}`);
  }
}
