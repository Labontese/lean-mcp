# Architecture

`lean-mcp` is a Model Context Protocol server built as a pipeline of six
optimization layers. Each layer has a narrow responsibility, a stable
interface, and its own tests. Layers can be enabled or disabled independently
so you can measure the impact of each.

**Implementation status**: L1–L6 are all implemented (Phases 1, 2 and 3
complete, **109 tests green**). L0 is planned for Phase 4 — see
[ROADMAP.md](ROADMAP.md).

## System overview

```
                 +----------------------------------+
                 |            Claude client          |
                 |      (Claude Code / Desktop)      |
                 +-----------------+----------------+
                                   |  MCP over stdio
                                   v
+-----------------------------------------------------------+
|                       lean-mcp server                      |
|                                                           |
|  L0  CLI Output Interceptor   (shell boundary)   [planned]|
|  L1  Lazy Tool Registry       (tool schemas)     [done]   |
|  L2  Semantic Context Dedup   (context in)       [done]   |
|  L3  Context Compression      (context in)       [done]   |
|  L4  Prompt Cache Orchestrator (prompt assembly) [done]   |
|  L5  Dynamic Model Router     (model selection)  [done]   |
|  L6  Observability Bus        (cross-cutting)    [done]   |
|                                                           |
|  In-memory state (L6 ring buffer, L4 hit tracking,        |
|  L2 seen-cache, L5 per-tier counters)                     |
|  SQLite persistence — planned for Phase 4                 |
+-----------------------------------------------------------+
                                   |
                                   v
                   +-----------------------------+
                   |  Anthropic API / local tools |
                   +-----------------------------+
```

## MCP tools currently exposed

With L1–L6 implemented, the server exposes nine meta-tools:

| Tool | Layer | Purpose |
|------|-------|---------|
| `search_tools` | L1 | Substring search over registered tool names/descriptions; returns `ToolSummary[]`. |
| `describe_tool` | L1 | Return the full `ToolDefinition` (name, description, schema) for a given tool name. |
| `execute_tool` | L1 | Invoke a registered tool by name with arbitrary JSON args. |
| `deduplicate_context` | L2 | Deduplicate a list of context strings; returns `DedupResult` (`original`, `deduplicated`, `removedCount`, `estimatedTokensSaved`). |
| `compress_context` | L3 | Compress older conversation turns; returns `CompressionResult` (`tokensBefore`, `tokensAfter`, `reductionPct`, `wasTriggered`). Uses Haiku API when available, placeholder otherwise. |
| `get_cache_stats` | L4 | Return `CacheStats` (`hits`, `misses`, `hitRate`, `estimatedSavingsPct`). |
| `route_model` | L5 | Classify a prompt; returns `ModelRoutingResult` (`tier`, `modelId`, `reasoning`, `confidenceScore`, `estimatedCostUsd`). |
| `get_session_stats` | L6 | Return a `SessionStats` snapshot for the current session (per-layer breakdown, top operations). |
| `get_recent_events` | L6 | Return the most recent `ObservabilityEvent` records from the ring buffer (default 50). |

## Layers

### L0 — CLI Output Interceptor *(planned)*

Wraps tool invocations that shell out (build, test, grep, lint, git) and
returns a compact structured summary instead of raw stdout. Inspired by the
Redux Toolkit pattern of collapsing noisy actions into a single normalized
payload.

- **Location**: shell-hook around tool execution
- **Input**: raw `stdout`/`stderr` from a spawned process
- **Output**: `{ exitCode, summary, highlights[], fullLogRef }`
- **Why it matters**: a failing `npm test` can emit 50k+ tokens of noise;
  L0 turns that into a few hundred tokens plus an opaque reference the model
  can fetch on demand.

### L1 — Lazy Tool Registry *(implemented)*

Most MCP servers ship *all* tool schemas on every request. That burns input
tokens the model rarely needs. L1 exposes three meta-tools —
`search_tools`, `describe_tool`, `execute_tool` — and loads a specific tool
schema only when the model asks to describe or execute it.

- **Implementation**: [`LazyRegistry`](../src/layers/l1-lazy-registry.ts)
- **Interface**: `ToolRegistry` in [`src/types/index.ts`](../src/types/index.ts)
  (`register` / `search` / `describe` / `execute`)
- **Telemetry**: every `search` / `describe` / `execute` call emits an
  `ObservabilityEvent` on the L6 bus with `operation`, `latencyMs`, and
  per-call metadata (query, result count, status).
- **Stats**: `getStats()` returns `RegistryStats` — `totalTools`,
  `searchCalls`, `describeCalls`, `executeCalls`.
- **Expected reduction**: up to 96% of tool-schema input tokens.
- **Tradeoff**: one extra round-trip when a tool is used for the first time
  in a session.

### L2 — Semantic Context Deduplication *(implemented)*

Removes duplicated items from a list of context strings before they reach the
model. Two detection paths are shipped today, with embeddings intentionally
deferred until evals justify the install footprint.

- **Implementation**: [`SemanticDedup`](../src/layers/l2-semantic-dedup.ts)
- **Detection**:
  1. **Exact match** — SHA-256 hash of the full string, O(1) comparison.
  2. **Fuzzy match** — Jaccard similarity over word 3-shingles (pure JS, no
     model dependency). Defaults to `fuzzyThreshold: 0.97` — "almost
     identical" — until evals justify lowering it.
  3. **Embedding match** — *not implemented*. Would require
     `@xenova/transformers` or similar; postponed pending a cost/benefit
     signal.
- **Ordering**: preserved. The first occurrence of each duplicate group wins.
- **Cache**: instance-level seen-hash list is FIFO-bounded by `maxCacheSize`
  (default 500) so long-running sessions cannot leak memory.
- **Config**: `DedupConfig` — `exactMatch`, `fuzzyMatch`, `fuzzyThreshold`,
  `maxCacheSize`.
- **Output**: `DedupResult` with `original`, `deduplicated`, `removedCount`,
  and `estimatedTokensSaved` (via the 4-chars-per-token heuristic).
- **Observability**: every `deduplicate()` call emits one `l2.deduplicate`
  event with `tokensBefore`, `tokensAfter`, `removedCount`, and the active
  threshold.

### L3 — Context Compression *(implemented)*

When the total token estimate of a conversation exceeds the configured
trigger, L3 folds the older turns into a single synthetic "summary" turn,
keeping the most recent `keepRecentTurns` intact as the active working set.

- **Implementation**: [`ContextCompression`](../src/layers/l3-compression.ts)
  plus the internal `AnthropicCompressor` helper.
- **Execution paths**:
  - **Async (`compressAsync`)** — calls the Anthropic Messages API against
    the configured Haiku model when `ANTHROPIC_API_KEY` is set at
    construction time. The `compress_context` MCP tool prefers this path
    when `hasLiveCompressor()` is true.
  - **Sync (`compress`)** — always returns the deterministic placeholder
    summary. Kept for environments without API credentials (dev, CI, tests)
    and for callers that can't block on a network round-trip.
- **Default config** (`CompressionConfig`): `triggerTokens: 8000`,
  `keepRecentTurns: 4`, `model: 'claude-haiku-4-5-20251001'`.
- **Guarantee**: when under the trigger threshold, the call is a no-op
  (`wasTriggered: false`, `compressed === original`).
- **Observability**: each triggered compression emits one `l3.compress`
  event with `tokensBefore`, `tokensAfter`, the split counts, the model
  used, and a `live` flag indicating whether the API or the placeholder
  produced the summary.
- **Pricing note**: Haiku-compressing ~10 turns runs well under $0.01 — the
  break-even versus carrying the raw history forward is typically one or two
  additional turns.

### L4 — Prompt Cache Orchestrator *(implemented)*

Anthropic's prompt cache rewards *stable prefixes*. L4 decides which
content blocks are worth marking with `cache_control`, tracks per-session
hit/miss statistics, and signals when cache breakpoints should be
re-positioned because they keep missing.

- **Implementation**: [`PromptCacheOrchestrator`](../src/layers/l4-prompt-cache.ts)
- **API**:
  - `shouldCache(content, type)` — `'system'` and `'tool_schema'` always
    cache; `'context'` caches when content exceeds 1000 chars.
  - `markForCache(content)` — wraps content with
    `cache_control: { type: 'ephemeral' }` as Anthropic expects.
  - `recordHit(content?)` / `recordMiss(content?, type?)` — update
    session counters; `recordMiss` also tracks the new entry for
    introspection.
  - `getStats()` — `{ hits, misses, hitRate, estimatedSavingsPct }`,
    never `NaN` on empty state.
  - `shouldAdjustBreakpoint()` — true after 3 consecutive misses.
- **Pricing model** (reference): cache-write costs 125% of base, cache-read
  costs 10% of base. A cached block needs to be hit roughly twice per
  5-minute window to break even on the write premium.
- **Observability**: hit/miss counters reported via `get_cache_stats`.

### L5 — Dynamic Model Router *(implemented)*

Classifies each request into a model tier (`haiku` / `sonnet` / `opus`) and
returns the pinned model ID, a human-readable reasoning string, a
confidence score, and a rough input-side cost estimate.

- **Implementation**: [`ModelRouter`](../src/layers/l5-model-router.ts)
- **Classification (heuristic, today)**:
  1. **Keyword match** — Opus keywords (`architecture`, `refactor`,
     `design`, `security`, …) or Haiku keywords (`format`, `rename`,
     `typo`, …).
  2. **Length signal** — prompts > 2000 chars → Opus; prompts < 60 chars
     with no code blocks → Haiku.
  3. **Code density** — ≥ 2 fenced code blocks suggest multi-file scope → Opus.
  4. **Fallback** — `config.defaultTier` (normally `sonnet`).
- **Enable flags**: a disabled tier (`enableHaiku: false` /
  `enableOpus: false`) is always replaced by a safe fallback — sonnet is the
  structural safety net and is never gated.
- **Pinned model IDs** (as of this release):
  - `haiku` → `claude-haiku-4-5-20251001`
  - `sonnet` → `claude-sonnet-4-6`
  - `opus` → `claude-opus-4-7`
- **Cost estimate**: input-side only, using the 4-chars-per-token heuristic
  and a per-tier price table (haiku $1, sonnet $3, opus $15 per 1M input
  tokens).
- **Stats**: `getStats()` returns per-tier counters plus the grand total.
- **Observability**: each `route()` call emits one `l5.route` event with the
  chosen tier, model ID, and confidence score.
- **Phase 4 upgrade path**: replace the heuristic with an Anthropic Messages
  call against Haiku (~50 tokens per decision, ≈ $0.00005) using a pinned
  system prompt. The heuristic remains as a fallback when the API is
  unavailable. Tracked in [ROADMAP.md](ROADMAP.md) Phase 4.

### L6 — Observability Bus *(implemented)*

Every other layer emits `ObservabilityEvent` records. L6 keeps the most
recent 1000 events in an in-memory ring buffer and exposes MCP tools that
return aggregated session stats and raw recent events.

- **Implementation**: [`ObservabilityBus`](../src/layers/l6-observability.ts)
- **Storage**: in-memory ring buffer, bounded at 1000 events (oldest dropped
  when full). SQLite persistence is planned for Phase 4.
- **Session identity**: each `ObservabilityBus` instance generates a
  stable `sessionId` (UUID) at construction time.
- **Event shape**: [`ObservabilityEvent`](../src/types/index.ts)
  ```ts
  {
    id: number;
    timestamp: number;
    layer: LayerName;       // 'l1' | 'l2' | ... | 'l6'
    operation: string;      // e.g. 'search_tools', 'deduplicate', 'compress', 'route'
    tokensBefore?: number;
    tokensAfter?: number;
    latencyMs?: number;
    metadata?: Record<string, unknown>;
  }
  ```
- **Aggregation** (`getStats()` → `SessionStats`):
  - `reductionPct` = `(1 - tokensAfter / tokensBefore) * 100`, 0 when empty
  - `byLayer`: `LayerStats[]` sorted l1 → l6, each with `eventCount`,
    `totalTokensSaved`, `avgLatencyMs`
  - `topOperations`: top 5 operations by tokens saved, deterministic tiebreak
- **Exposed tools**: `get_session_stats`, `get_recent_events`.
- **Integration**: L1, L2, L3, L5 all emit events today. L4 exposes its
  hit/miss counters directly through `get_cache_stats`.

## Request / response data flow

The diagram below shows the end-to-end flow. L0 remains a pass-through
until the interceptor lands in Phase 4; every other stop is live.

```
  Claude client
       |
       | 1. MCP request (tool list or tool call)
       v
  L1 Registry ----> returns meta-tool summaries or full schema on demand
       |                                                           [done]
       | 2. tool execute
       v
  L2 Dedup --------> removes redundant context                     [done]
       |
       v
  L3 Compress -----> shrinks older turns when over budget (Haiku)  [done]
       |
       v
  L4 Cache --------> pins stable prefix, inserts cache markers     [done]
       |
       v
  L5 Router -------> picks model tier + model ID                   [done]
       |
       v
  Anthropic API (or L0-wrapped local tool)
       |
       v
  L6 Observability-> records operation, latency, tokens            [done]
       |
       v
  Claude client
```

## State and storage

All state is kept in-memory per server process:

- **L2 `SemanticDedup`** — FIFO seen-hash list (bounded by `maxCacheSize`),
  hash-to-content map, and shingle cache.
- **L3 `ContextCompression`** — stateless between calls; the optional
  `AnthropicCompressor` holds a lazily-constructed Anthropic client when
  `ANTHROPIC_API_KEY` is configured.
- **L4 `PromptCacheOrchestrator`** — hit/miss counters and a `Map` of
  tracked entries keyed by SHA-256 content hash.
- **L5 `ModelRouter`** — per-tier counters (`haiku` / `sonnet` / `opus`).
- **L6 `ObservabilityBus`** — ring buffer of the last 1000 events plus
  a per-instance `sessionId` and `startedAt` timestamp.

There is no SQLite database yet. When SQLite lands in Phase 4 (for L2
embeddings if we upgrade the dedup path, L6 event persistence, and
L0/L3 `fullLogRef` blobs), the schema will be roughly:

```sql
-- Embedding cache for a future L2 upgrade
CREATE TABLE embeddings (
  content_hash TEXT PRIMARY KEY,
  vector BLOB NOT NULL,
  created_at INTEGER NOT NULL
);

-- Observability events from L6 (currently in-memory)
CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp INTEGER NOT NULL,
  session_id TEXT NOT NULL,
  layer TEXT NOT NULL,
  operation TEXT NOT NULL,
  tokens_before INTEGER,
  tokens_after INTEGER,
  latency_ms INTEGER,
  metadata TEXT
);

-- Full-log references for L0 / L3
CREATE TABLE blobs (
  ref TEXT PRIMARY KEY,
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_events_session ON events(session_id, timestamp);
```

## Key abstractions

- [`LeanMcpServer`](../src/server.ts) — thin wrapper over the MCP SDK's
  `Server` + `StdioServerTransport`
- [`LazyRegistry`](../src/layers/l1-lazy-registry.ts) — L1 implementation
  of the `ToolRegistry` interface
- [`SemanticDedup`](../src/layers/l2-semantic-dedup.ts) — L2 exact +
  Jaccard-fuzzy deduplicator
- [`ContextCompression`](../src/layers/l3-compression.ts) /
  [`AnthropicCompressor`](../src/layers/l3-compression.ts) — L3 Haiku
  summariser with deterministic-placeholder fallback
- [`PromptCacheOrchestrator`](../src/layers/l4-prompt-cache.ts) — L4 cache
  decision and statistics surface
- [`ModelRouter`](../src/layers/l5-model-router.ts) — L5 heuristic tier
  classifier
- [`ObservabilityBus`](../src/layers/l6-observability.ts) — L6 in-memory
  ring buffer and aggregation
- [`ToolRegistry`](../src/types/index.ts) — L1's core interface
- [`ObservabilityEvent`](../src/types/index.ts) — the single event shape
  every layer emits
- [`DedupConfig`](../src/types/index.ts) / [`DedupResult`](../src/types/index.ts) —
  L2 types
- [`CompressionConfig`](../src/types/index.ts) /
  [`CompressionResult`](../src/types/index.ts) /
  [`ConversationTurn`](../src/types/index.ts) — L3 types
- [`CacheEntry`](../src/types/index.ts) / [`CacheStats`](../src/types/index.ts) —
  L4 cache types
- [`RouterConfig`](../src/types/index.ts) /
  [`ModelRoutingResult`](../src/types/index.ts) /
  [`ModelTier`](../src/types/index.ts) — L5 router types
- [`SessionStats`](../src/types/index.ts) / [`LayerStats`](../src/types/index.ts) —
  L6 aggregation types

## Directory structure

```
src/
├── index.ts                  # CLI entry point (#!/usr/bin/env node)
├── server.ts                 # MCP server wrapper
├── layers/
│   ├── l1-lazy-registry.ts   # implemented
│   ├── l2-semantic-dedup.ts  # implemented
│   ├── l3-compression.ts     # implemented (Haiku API + placeholder)
│   ├── l4-prompt-cache.ts    # implemented
│   ├── l5-model-router.ts    # implemented (heuristic)
│   └── l6-observability.ts   # implemented
├── tools/                    # MCP meta-tool definitions
├── storage/                  # SQLite wrapper (planned, Phase 4)
└── types/                    # shared TypeScript types
tests/
├── l1.test.ts
├── l2.test.ts
├── l3.test.ts
├── l3-async.test.ts          # Haiku-API path with injected fake client
├── l4.test.ts
├── l5.test.ts
├── l6.test.ts
└── integration.test.ts       # cross-layer wiring
```
