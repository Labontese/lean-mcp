import type { LazyRegistry } from '../layers/l1-lazy-registry.js';

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
] as const;

export type MetaToolName = (typeof META_TOOLS)[number]['name'];

export async function handleMetaTool(
  registry: LazyRegistry,
  name: string,
  args: Record<string, unknown>,
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
    default:
      throw new Error(`Unknown meta-tool: ${name}`);
  }
}
