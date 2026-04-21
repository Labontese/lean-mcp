# Roadmap

`lean-mcp` ships in phases. Each phase validates a hypothesis before the next
one starts. Nothing here is a hard commitment — priorities shift when real
telemetry tells us something new.

## Phase 1 — MVP: validate the hypothesis ✅ DONE

**Goal**: prove that lazy tool schemas plus prompt cache orchestration
measurably reduce tokens for real Claude Code sessions.

- ✅ **L1 Lazy Tool Registry** — `search_tools` / `describe_tool` /
  `execute_tool` meta-tools, registration API, schema-on-demand.
  Implemented in commit `a717e25`. 14 tests green.
- ✅ **L4 Prompt Cache Orchestrator** — `shouldCache`, `markForCache`,
  `recordHit` / `recordMiss`, `getStats`, `shouldAdjustBreakpoint`.
  Anthropic `cache_control: { type: 'ephemeral' }` markers. Exposed via
  `get_cache_stats` MCP tool. Implemented in commit `1b2474e`. 17 tests green.
- ✅ **L6 Observability Bus** — in-memory ring buffer (1000 events),
  `SessionStats` / `LayerStats` aggregation, `get_session_stats` and
  `get_recent_events` MCP tools. Wired to L1 for per-operation telemetry.
  Implemented in commit `d66a27f`. 16 tests green.

**Status**: Phase 1 complete.

## Phase 2 — richer context handling ✅ DONE

**Goal**: bring context-window costs down once the MVP validates savings.

- ✅ **L2 Semantic Context Deduplication** — exact hash-match plus Jaccard
  similarity over word 3-shingles (pure JS, no embedding model). FIFO
  seen-cache bounded by `maxCacheSize`. Exposed via `deduplicate_context`
  MCP tool. Implemented in commit `b446089`.
- ✅ **L3 Context Compression** — Haiku-backed summarisation for
  older turns once total tokens exceed the trigger threshold. Calls the
  Anthropic Messages API when `ANTHROPIC_API_KEY` is set; falls back to a
  deterministic placeholder summary otherwise. Exposed via `compress_context`
  MCP tool. Implemented in commit `ecb446e`.

**Status**: Phase 2 complete. SQLite persistence for L6 events and
`fullLogRef` retrieval deferred to a later phase.

## Phase 3 — routing and observability surface ✅ DONE

**Goal**: make per-request cost decisions explicit and expose the router
surface so clients can pick a tier without guessing.

- ✅ **L5 Dynamic Model Router** — heuristic classifier (keyword match,
  prompt length, code-block density) mapping each request to a tier
  (`haiku` / `sonnet` / `opus`) with pinned model IDs, reasoning string,
  confidence score, and USD cost estimate. Exposed via `route_model` MCP
  tool. Implemented in commit `df89f37`.

**Status**: Phase 3 complete. All 6 layers now implemented. **109 tests green**
across the codebase.

## Phase 4 — model-driven routing and scale

**Goal**: move the router from deterministic heuristics to model-driven
classification and support multi-project deployments.

- ⏳ **API-based model classifier** — replace the heuristic path in L5
  with a Haiku call (~50 tokens per decision, ≈ $0.00005) using a pinned
  system prompt. Keep the heuristic as a fallback when the API is
  unavailable.
- ⏳ **A/B testing harness** — run two routing policies in parallel on the
  same session stream, compare cost and quality side-by-side.
- ⏳ **Multi-repo support** — a single `lean-mcp` instance serving several
  projects, with per-project budgets and reports.
- ⏳ **L0 CLI Output Interceptor** — wrap shell-out tools and return a
  compact summary plus `fullLogRef` instead of raw stdout/stderr.
- ⏳ **SQLite persistence** — durable storage for L6 events, L2 embedding
  cache (if we upgrade L2 from Jaccard to real embeddings), and
  `fullLogRef` blobs for L0 / L3.
