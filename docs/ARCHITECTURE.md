# Architecture

`lean-mcp` is a Model Context Protocol server built as a pipeline of six
optimization layers. Each layer has a narrow responsibility, a stable
interface, and its own tests. Layers can be enabled or disabled independently
so you can measure the impact of each.

**Implementation status**: L1, L4, and L6 are implemented (Phase 1 complete,
49 tests green). L0, L2, L3, and L5 are planned — see
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
|  L2  Semantic Context Dedup   (context in)       [planned]|
|  L3  Context Compression      (context in)       [planned]|
|  L4  Prompt Cache Orchestrator (prompt assembly) [done]   |
|  L5  Dynamic Model Router     (model selection)  [planned]|
|  L6  Observability Bus        (cross-cutting)    [done]   |
|                                                           |
|  In-memory state (L6 ring buffer, L4 hit tracking)        |
|  SQLite persistence — planned for Phase 2                 |
+-----------------------------------------------------------+
                                   |
                                   v
                   +-----------------------------+
                   |  Anthropic API / local tools |
                   +-----------------------------+
```

## MCP tools currently exposed

With L1, L4 and L6 implemented, the server exposes six meta-tools:

| Tool | Layer | Purpose |
|------|-------|---------|
| `search_tools` | L1 | Substring search over registered tool names/descriptions; returns `ToolSummary[]`. |
| `describe_tool` | L1 | Return the full `ToolDefinition` (name, description, schema) for a given tool name. |
| `execute_tool` | L1 | Invoke a registered tool by name with arbitrary JSON args. |
| `get_cache_stats` | L4 | Return `CacheStats` (`hits`, `misses`, `hitRate`, `estimatedSavingsPct`). |
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

### L2 — Semantic Context Deduplication *(planned)*

Embeds each context chunk (file slice, search result, previous turn) with a
small local model and removes chunks whose cosine similarity to something
already in the window exceeds a threshold.

- **Embedding model**: `@xenova/transformers` (runs locally, no API cost)
- **Storage**: embeddings cached in SQLite keyed by content hash
- **Default threshold**: tunable per session

### L3 — Context Compression *(planned)*

When remaining context still exceeds a budget, L3 calls Claude Haiku with a
strict summarization prompt to shrink the lowest-priority chunks. High-priority
chunks (current file, user's latest message, tool results) are never compressed.

- **Model**: `claude-haiku` (cheapest Anthropic model)
- **Guarantee**: original content is retrievable via `fullLogRef` / content hash

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

### L5 — Dynamic Model Router *(planned)*

Classifies each request (tool-execution, simple-edit, reasoning, planning) and
routes to the cheapest model that passes a minimum quality bar. Defaults to
pass-through (use the model the client asked for) until enough telemetry exists
to trust routing.

- **Default policy**: pass-through
- **Future policies**: pattern-based routing, A/B test routing, confidence
  routing

### L6 — Observability Bus *(implemented)*

Every other layer emits `ObservabilityEvent` records. L6 keeps the most
recent 1000 events in an in-memory ring buffer and exposes MCP tools that
return aggregated session stats and raw recent events.

- **Implementation**: [`ObservabilityBus`](../src/layers/l6-observability.ts)
- **Storage**: in-memory ring buffer, bounded at 1000 events (oldest dropped
  when full). SQLite persistence is planned for Phase 2.
- **Session identity**: each `ObservabilityBus` instance generates a
  stable `sessionId` (UUID) at construction time.
- **Event shape**: [`ObservabilityEvent`](../src/types/index.ts)
  ```ts
  {
    id: number;
    timestamp: number;
    layer: LayerName;       // 'l1' | 'l2' | ... | 'l6'
    operation: string;      // e.g. 'search_tools', 'describe_tool'
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
- **Integration**: L1 already emits events; L2–L5 will emit when
  implemented.

## Request / response data flow

The diagram below shows the intended end-to-end flow. Today only L1, L4,
and L6 are active in the pipeline; the other stops are pass-through until
the remaining layers land.

```
  Claude client
       |
       | 1. MCP request (tool list or tool call)
       v
  L1 Registry ----> returns meta-tool summaries or full schema on demand
       |                                                           [done]
       | 2. tool execute
       v
  L2 Dedup --------> removes redundant context                  [planned]
       |
       v
  L3 Compress -----> shrinks low-priority chunks if over budget [planned]
       |
       v
  L4 Cache --------> pins stable prefix, inserts cache markers     [done]
       |
       v
  L5 Router -------> picks model                                [planned]
       |
       v
  Anthropic API (or L0-wrapped local tool)
       |
       v
  L6 Observability-> records operation, latency, tokens           [done]
       |
       v
  Claude client
```

## State and storage

Phase 1 keeps all state in-memory per server process:

- **L4 `PromptCacheOrchestrator`** — hit/miss counters and a `Map` of
  tracked entries keyed by SHA-256 content hash.
- **L6 `ObservabilityBus`** — ring buffer of the last 1000 events plus
  a per-instance `sessionId` and `startedAt` timestamp.

There is no SQLite database yet. When SQLite lands in Phase 2 (for L2
embeddings, L6 event persistence, and L0/L3 `fullLogRef` blobs), the
schema will be roughly:

```sql
-- Embedding cache for L2 (planned)
CREATE TABLE embeddings (
  content_hash TEXT PRIMARY KEY,
  vector BLOB NOT NULL,
  created_at INTEGER NOT NULL
);

-- Observability events from L6 (planned — currently in-memory)
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

-- Full-log references for L0 / L3 (planned)
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
- [`PromptCacheOrchestrator`](../src/layers/l4-prompt-cache.ts) — L4 cache
  decision and statistics surface
- [`ObservabilityBus`](../src/layers/l6-observability.ts) — L6 in-memory
  ring buffer and aggregation
- [`ToolRegistry`](../src/types/index.ts) — L1's core interface
  (`register` / `search` / `describe` / `execute`)
- [`ObservabilityEvent`](../src/types/index.ts) — the single event shape every
  layer emits
- [`CacheEntry`](../src/types/index.ts) / [`CacheStats`](../src/types/index.ts) —
  L4 cache types
- [`SessionStats`](../src/types/index.ts) / [`LayerStats`](../src/types/index.ts) —
  L6 aggregation types

## Directory structure

```
src/
├── index.ts                  # CLI entry point (#!/usr/bin/env node)
├── server.ts                 # MCP server wrapper
├── layers/
│   ├── l1-lazy-registry.ts   # implemented
│   ├── l4-prompt-cache.ts    # implemented
│   └── l6-observability.ts   # implemented
├── tools/                    # MCP tool definitions
├── storage/                  # SQLite wrapper (planned)
└── types/                    # shared TypeScript types
tests/
├── l1.test.ts                # 14 tests
├── l4.test.ts                # 17 tests
├── l6.test.ts                # 16 tests
└── integration.test.ts       # cross-layer wiring
```
