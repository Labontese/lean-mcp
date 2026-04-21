export interface LayerConfig {
  enabled: boolean;
}

export type LayerName = 'l1' | 'l2' | 'l3' | 'l4' | 'l5' | 'l6';

export interface ObservabilityEvent {
  id: number;
  timestamp: number;
  layer: LayerName;
  operation: string;
  tokensBefore?: number;
  tokensAfter?: number;
  latencyMs?: number;
  metadata?: Record<string, unknown>;
}

export interface LayerStats {
  layer: LayerName;
  eventCount: number;
  totalTokensSaved: number;
  avgLatencyMs: number;
}

export interface SessionStats {
  sessionId: string;
  startedAt: number;
  totalEvents: number;
  totalTokensBefore: number;
  totalTokensAfter: number;
  reductionPct: number;
  byLayer: LayerStats[];
  topOperations: Array<{ operation: string; count: number; tokensSaved: number }>;
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

export interface DedupConfig {
  /** Enable exact hash-based matching (O(1)). */
  exactMatch: boolean;
  /** Enable Jaccard-based fuzzy matching over word 3-shingles. */
  fuzzyMatch: boolean;
  /**
   * Jaccard similarity threshold above which two strings are considered
   * duplicates. Range [0, 1]. Default 0.97 (extremely conservative until
   * we have evals); lower values catch looser similarity.
   */
  fuzzyThreshold: number;
  /** Maximum number of entries kept in the seen-cache (FIFO eviction). */
  maxCacheSize: number;
}

export interface DedupResult {
  original: string[];
  deduplicated: string[];
  removedCount: number;
  /**
   * Rough token-saving estimate:
   *   removedCount * avgCharsPerRemovedItem / 4
   * Uses the 4-chars-per-token heuristic Anthropic documents for English.
   */
  estimatedTokensSaved: number;
}

// L3 — Context Compression

export interface ConversationTurn {
  role: 'user' | 'assistant';
  content: string;
  /** Rough estimate: content.length / 4 (Anthropic's English heuristic). */
  tokenEstimate: number;
}

export interface CompressionConfig {
  /** Activate compression when total token estimate exceeds this. */
  triggerTokens: number;
  /** Keep the most recent N turns fully intact. */
  keepRecentTurns: number;
  /** Model used for the (eventual) summarisation call. */
  model: string;
}

export interface CompressionResult {
  original: ConversationTurn[];
  compressed: ConversationTurn[];
  tokensBefore: number;
  tokensAfter: number;
  /** (tokensBefore - tokensAfter) / tokensBefore * 100; 0 when not triggered. */
  reductionPct: number;
  /** False when under the trigger threshold — `compressed` equals `original`. */
  wasTriggered: boolean;
}
