export interface LayerConfig {
  enabled: boolean;
}

export interface ObservabilityEvent {
  timestamp: number;
  layer: string;
  tokensBefore: number;
  tokensAfter: number;
  latencyMs: number;
}

export type ToolHandler = (args: Record<string, unknown>) => Promise<unknown> | unknown;

export interface ToolDefinition {
  name: string;
  description: string;
  schema: object;
  handler: ToolHandler;
}

export interface ToolSummary {
  name: string;
  description: string;
}

export interface RegistryStats {
  totalTools: number;
  searchCalls: number;
  describeCalls: number;
  executeCalls: number;
}

export interface ToolRegistry {
  register(tool: ToolDefinition): void;
  search(query: string): ToolSummary[];
  describe(name: string): ToolDefinition | null;
  execute(name: string, args: Record<string, unknown>): Promise<unknown>;
}
