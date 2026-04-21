# Roadmap

`lean-mcp` ships in phases. Each phase validates a hypothesis before the next
one starts. Nothing here is a hard commitment — priorities shift when real
telemetry tells us something new.

## Phase 1 — MVP: validate the hypothesis

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

**Status**: Phase 1 implementation complete. 49 tests total, all green.
SQLite persistence for L6 deferred to Phase 2.

**Exit criterion**: a real session shows ≥ 40% input-token reduction versus a
baseline run with layers disabled.

## Phase 2 — richer context handling

**Goal**: bring context-window costs down once the MVP validates savings.

- ⏳ **L2 Semantic Context Deduplication** — local embedding cache,
  cosine-similarity threshold, integration with L1 tool results.
- ⏳ **L3 Context Compression** — Haiku-backed summarization for
  low-priority chunks, `fullLogRef` retrieval path.
- ⏳ **Session state** — stable `session_id` across turns, per-session budgets,
  session-scoped observability reports. SQLite persistence for L6 events.

## Phase 3 — multi-agent and developer UX

**Goal**: make `lean-mcp` useful for agent-heavy workflows and expose savings
in a way humans actually look at.

- ⏳ **Agent hand-off compression** — shrink the context passed between parent
  and subagent while preserving task intent.
- ⏳ **Cost dashboard** — read-only web UI backed by the SQLite event store.
- ⏳ **Feedback loop** — clients can tag a turn as "good" / "bad", informing
  future compression and routing decisions.

## Phase 4 — routing and scale

**Goal**: move from passive optimization to active decisions about *which
model runs which turn*.

- ⏳ **L5 Dynamic Model Router** — request classifier, per-policy routing,
  confidence-based fallback to the originally-requested model.
- ⏳ **A/B testing harness** — run two policies in parallel on the same session
  stream, compare cost and quality.
- ⏳ **Multi-repo support** — a single `lean-mcp` instance serving several
  projects, with per-project budgets and reports.
