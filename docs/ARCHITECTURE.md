# Architecture

`lean-mcp` is a Model Context Protocol server built as a pipeline of six
optimization layers. Each layer has a narrow responsibility, a stable
interface, and its own tests. Layers can be enabled or disabled independently
so you can measure the impact of each.

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
|  L0  CLI Output Interceptor   (shell boundary)            |
|  L1  Lazy Tool Registry       (tool schemas)              |
|  L2  Semantic Context Dedup   (context in)                |
|  L3  Context Compression      (context in)                |
|  L4  Prompt Cache Orchestrator (prompt assembly)          |
|  L5  Dynamic Model Router     (model selection)           |
|  L6  Observability Bus        (cross-cutting)             |
|                                                           |
|                     SQLite (better-sqlite3)               |
+-----------------------------------------------------------+
                                   |
                                   v
                   +-----------------------------+
                   |  Anthropic API / local tools |
                   +-----------------------------+
```

## Layers

### L0 — CLI Output Interceptor

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

### L1 — Lazy Tool Registry

Most MCP servers ship *all* tool schemas on every request. That burns input
tokens the model rarely needs. L1 exposes three meta-tools — `search`,
`describe`, `execute` — and loads a specific tool schema only when the model
asks to describe or execute it.

- **Interface**: `ToolRegistry` in [`src/types/index.ts`](../src/types/index.ts)
- **Expected reduction**: up to 96% of tool-schema input tokens.
- **Tradeoff**: one extra round-trip when a tool is used for the first time
  in a session.

### L2 — Semantic Context Deduplication

Embeds each context chunk (file slice, search result, previous turn) with a
small local model and removes chunks whose cosine similarity to something
already in the window exceeds a threshold.

- **Embedding model**: `@xenova/transformers` (runs locally, no API cost)
- **Storage**: embeddings cached in SQLite keyed by content hash
- **Default threshold**: tunable per session

### L3 — Context Compression

When remaining context still exceeds a budget, L3 calls Claude Haiku with a
strict summarization prompt to shrink the lowest-priority chunks. High-priority
chunks (current file, user's latest message, tool results) are never compressed.

- **Model**: `claude-haiku` (cheapest Anthropic model)
- **Guarantee**: original content is retrievable via `fullLogRef` / content hash

### L4 — Prompt Cache Orchestrator

Anthropic's prompt cache rewards *stable prefixes*. L4 reorders and pins the
assembled prompt so that the system prompt, tool catalog, and long-lived
context appear at stable offsets across turns, dramatically increasing cache
hit rate.

- **Uses**: Anthropic `cache_control` markers on stable segments
- **Observability**: reports cache hits/misses via L6

### L5 — Dynamic Model Router

Classifies each request (tool-execution, simple-edit, reasoning, planning) and
routes to the cheapest model that passes a minimum quality bar. Defaults to
pass-through (use the model the client asked for) until enough telemetry exists
to trust routing.

- **Default policy**: pass-through
- **Future policies**: pattern-based routing, A/B test routing, confidence
  routing

### L6 — Observability Bus

Every other layer emits `ObservabilityEvent` records. L6 persists them to
SQLite and exposes an MCP tool that returns a per-session cost/token report.

- **Event shape**: [`ObservabilityEvent`](../src/types/index.ts)
  ```ts
  { timestamp, layer, tokensBefore, tokensAfter, latencyMs }
  ```
- **Exposed tool**: `lean_mcp_report` — returns totals + per-layer breakdown

## Request / response data flow

```
  Claude client
       |
       | 1. MCP request (tool list or tool call)
       v
  L1 Registry ----> returns meta-tool summaries or full schema on demand
       |
       | 2. tool execute
       v
  L2 Dedup --------> removes redundant context
       |
       v
  L3 Compress -----> shrinks low-priority chunks if over budget
       |
       v
  L4 Cache --------> pins stable prefix, inserts cache markers
       |
       v
  L5 Router -------> picks model
       |
       v
  Anthropic API (or L0-wrapped local tool)
       |
       v
  L6 Observability-> records tokensBefore/After, latency, cost
       |
       v
  Claude client
```

## Storage schema (SQLite)

`lean-mcp` uses `better-sqlite3` for local state. The schema is intentionally
small — everything else is derived.

```sql
-- Embedding cache for L2
CREATE TABLE embeddings (
  content_hash TEXT PRIMARY KEY,
  vector BLOB NOT NULL,
  created_at INTEGER NOT NULL
);

-- Observability events from L6
CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp INTEGER NOT NULL,
  session_id TEXT NOT NULL,
  layer TEXT NOT NULL,
  tokens_before INTEGER NOT NULL,
  tokens_after INTEGER NOT NULL,
  latency_ms INTEGER NOT NULL
);

-- Full-log references for L0 / L3 (content fetched on demand)
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
- [`ToolRegistry`](../src/types/index.ts) — L1's core interface
  (`register` / `search` / `describe` / `execute`)
- [`ObservabilityEvent`](../src/types/index.ts) — the single event shape every
  layer emits
- [`Storage`](../src/storage/db.ts) — SQLite wrapper (to be implemented)

## Directory structure

```
src/
├── index.ts           # CLI entry point (#!/usr/bin/env node)
├── server.ts          # MCP server wrapper
├── layers/            # one file per optimization layer (L1-L6)
├── tools/             # MCP tool definitions
├── storage/           # SQLite wrapper
└── types/             # shared TypeScript types
tests/
├── l1.test.ts         # one test file per layer
├── l2.test.ts
└── integration.test.ts
```
