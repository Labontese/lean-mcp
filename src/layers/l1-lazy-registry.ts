import type { ObservabilityBus } from './l6-observability.js';
import type {
  RegistryStats,
  ToolDefinition,
  ToolRegistry,
  ToolSummary,
} from '../types/index.js';

export class LazyRegistry implements ToolRegistry {
  private tools = new Map<string, ToolDefinition>();
  private searchCalls = 0;
  private describeCalls = 0;
  private executeCalls = 0;
  private readonly bus?: ObservabilityBus;

  constructor(bus?: ObservabilityBus) {
    this.bus = bus;
  }

  register(tool: ToolDefinition): void {
    if (!tool.name) {
      throw new Error('Tool must have a name');
    }
    this.tools.set(tool.name, tool);
  }

  search(query: string): ToolSummary[] {
    this.searchCalls++;
    const start = Date.now();
    const needle = query.toLowerCase().trim();

    // Empty query returns all tools — callers may want a full listing.
    const results: ToolSummary[] = [];
    for (const tool of this.tools.values()) {
      if (needle === '') {
        results.push({ name: tool.name, description: tool.description });
        continue;
      }
      const haystack = `${tool.name} ${tool.description}`.toLowerCase();
      if (haystack.includes(needle)) {
        results.push({ name: tool.name, description: tool.description });
      }
    }
    this.bus?.emit({
      layer: 'l1',
      operation: 'search_tools',
      latencyMs: Date.now() - start,
      metadata: { query, resultCount: results.length },
    });
    return results;
  }

  describe(name: string): ToolDefinition | null {
    this.describeCalls++;
    const start = Date.now();
    const result = this.tools.get(name) ?? null;
    this.bus?.emit({
      layer: 'l1',
      operation: 'describe_tool',
      latencyMs: Date.now() - start,
      metadata: { name, found: result !== null },
    });
    return result;
  }

  async execute(name: string, args: Record<string, unknown>): Promise<unknown> {
    this.executeCalls++;
    const start = Date.now();
    const tool = this.tools.get(name);
    if (!tool) {
      this.bus?.emit({
        layer: 'l1',
        operation: 'execute_tool',
        latencyMs: Date.now() - start,
        metadata: { name, status: 'unknown' },
      });
      throw new Error(`Unknown tool: ${name}`);
    }
    try {
      const result = await tool.handler(args);
      this.bus?.emit({
        layer: 'l1',
        operation: 'execute_tool',
        latencyMs: Date.now() - start,
        metadata: { name, status: 'ok' },
      });
      return result;
    } catch (err) {
      this.bus?.emit({
        layer: 'l1',
        operation: 'execute_tool',
        latencyMs: Date.now() - start,
        metadata: {
          name,
          status: 'error',
          error: err instanceof Error ? err.message : String(err),
        },
      });
      throw err;
    }
  }

  getStats(): RegistryStats {
    return {
      totalTools: this.tools.size,
      searchCalls: this.searchCalls,
      describeCalls: this.describeCalls,
      executeCalls: this.executeCalls,
    };
  }
}
