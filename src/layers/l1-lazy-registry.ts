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

  register(tool: ToolDefinition): void {
    if (!tool.name) {
      throw new Error('Tool must have a name');
    }
    this.tools.set(tool.name, tool);
  }

  search(query: string): ToolSummary[] {
    this.searchCalls++;
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
    return results;
  }

  describe(name: string): ToolDefinition | null {
    this.describeCalls++;
    return this.tools.get(name) ?? null;
  }

  async execute(name: string, args: Record<string, unknown>): Promise<unknown> {
    this.executeCalls++;
    const tool = this.tools.get(name);
    if (!tool) {
      throw new Error(`Unknown tool: ${name}`);
    }
    return await tool.handler(args);
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
