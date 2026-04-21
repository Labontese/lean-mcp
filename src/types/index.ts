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
