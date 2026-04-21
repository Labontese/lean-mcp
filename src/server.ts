import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { LazyRegistry } from './layers/l1-lazy-registry.js';
import { SemanticDedup } from './layers/l2-semantic-dedup.js';
import { ContextCompression } from './layers/l3-compression.js';
import { PromptCacheOrchestrator } from './layers/l4-prompt-cache.js';
import { ObservabilityBus } from './layers/l6-observability.js';
import { META_TOOLS, handleMetaTool } from './tools/index.js';

export class LeanMcpServer {
  private server: Server;
  public readonly registry: LazyRegistry;
  public readonly dedup: SemanticDedup;
  public readonly compression: ContextCompression;
  public readonly promptCache: PromptCacheOrchestrator;
  public readonly observability: ObservabilityBus;

  constructor() {
    this.observability = new ObservabilityBus();
    this.registry = new LazyRegistry(this.observability);
    this.dedup = new SemanticDedup({}, this.observability);
    this.compression = new ContextCompression(undefined, this.observability);
    this.promptCache = new PromptCacheOrchestrator();
    this.server = new Server(
      { name: 'lean-mcp', version: '0.1.0' },
      { capabilities: { tools: {} } },
    );
    this.registerHandlers();
  }

  private registerHandlers(): void {
    // Only the meta-tools are exposed to the client — real tools are
    // discovered lazily through search_tools/describe_tool.
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: META_TOOLS.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      })),
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;
      const result = await handleMetaTool(
        this.registry,
        name,
        (args ?? {}) as Record<string, unknown>,
        this.promptCache,
        this.observability,
        this.compression,
        this.dedup,
      );
      return {
        content: [
          {
            type: 'text',
            text: typeof result === 'string' ? result : JSON.stringify(result),
          },
        ],
      };
    });
  }

  async start() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error('lean-mcp server running');
  }
}
