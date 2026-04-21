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

export type CacheContentType = 'system' | 'tool_schema' | 'context';

export interface CacheEntry {
  content: string;
  hash: string; // sha256 of content
  createdAt: number;
  hitCount: number;
  lastHitAt: number;
  type: CacheContentType;
}

export interface CacheStats {
  hits: number;
  misses: number;
  hitRate: number;
  estimatedSavingsPct: number; // (hits * 0.9) / (hits + misses) * 100
}

export interface CacheControlHint {
  type: 'ephemeral';
}

export interface CacheMarkedContent {
  content: string;
  cache_control: CacheControlHint;
}
