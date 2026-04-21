# lean-mcp

[![CI](https://github.com/Labontese/lean-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/Labontese/lean-mcp/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/lean-mcp.svg)](https://www.npmjs.com/package/lean-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

> Up to 90% token reduction for Claude — without changing how you work.

`lean-mcp` is a Model Context Protocol (MCP) server that sits between Claude
(Code or Desktop) and the tools, context, and models you already use. It applies
six composable optimization layers that together reduce token usage, latency,
and cost — while leaving your existing workflow untouched.

## The 6 layers

| Layer | Name | What it does | Status |
|-------|------|--------------|--------|
| **L0** | CLI Output Interceptor | Captures noisy CLI output at the shell boundary and returns a compact summary to the model. | Planned |
| **L1** | Lazy Tool Registry | Loads tool schemas on demand instead of upfront, cutting input tokens by up to 96%. | **Implemented** |
| **L2** | Semantic Context Deduplication | Detects and removes semantically redundant context chunks before they reach the model. | Planned |
| **L3** | Context Compression | Uses a cheap model (Haiku) to summarize long context windows while preserving signal. | Planned |
| **L4** | Prompt Cache Orchestrator | Orders, groups, and pins prompt segments to maximize Anthropic prompt cache hits. | **Implemented** |
| **L5** | Dynamic Model Router | Routes each request to the cheapest model that meets the quality bar. | Planned |
| **L6** | Observability Bus | Records token, latency, and cost metrics per layer so you can see exactly what each layer saves. | **Implemented** |

## Work in progress

`lean-mcp` is under active development. **3 of 6 layers are implemented**
(L1, L4, L6) — that's Phase 1 complete. 49 tests green across the codebase.

**Available right now:**
- L1 Lazy Tool Registry — meta-tools for on-demand schema loading
- L4 Prompt Cache Orchestrator — cache breakpoint decisions + hit/miss stats
- L6 Observability Bus — in-memory ring buffer (1000 events) and session
  stats, wired to L1

**Coming in later phases:**
- L2 Semantic Context Dedup, L3 Context Compression, L5 Dynamic Model
  Router, L0 CLI Output Interceptor, and SQLite persistence for L6.

See [docs/ROADMAP.md](docs/ROADMAP.md) for the phased plan and
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for implementation details.

## MCP tools exposed today

With L1, L4 and L6 active, the server currently exposes six meta-tools:

| Tool | Layer | What it does |
|------|-------|--------------|
| `search_tools` | L1 | Substring search over registered tool names/descriptions. |
| `describe_tool` | L1 | Return the full schema for a specific tool by name. |
| `execute_tool` | L1 | Invoke a registered tool with JSON args. |
| `get_cache_stats` | L4 | Return cache hits, misses, hit rate, and estimated savings. |
| `get_session_stats` | L6 | Return a snapshot of per-layer stats and top operations for the current session. |
| `get_recent_events` | L6 | Return the most recent observability events (default 50). |

## How it compares

| Feature | Caveman | Token Savior | CRG | Token Optimizer MCP | Claude Context | **lean-mcp** |
|---|---|---|---|---|---|---|
| Lazy tool schemas | — | — | — | partial | — | **yes (L1)** |
| Semantic deduplication | — | — | partial | — | — | **planned (L2)** |
| Context compression | — | partial | — | partial | — | **planned (L3)** |
| Prompt cache orchestration | — | — | — | — | — | **yes (L4)** |
| Dynamic model routing | — | — | — | — | — | **planned (L5)** |
| Per-layer observability | — | — | — | — | — | **yes (L6)** |
| CLI output interception | — | — | — | — | — | **planned (L0)** |
| Works with Claude Code & Desktop | partial | partial | partial | yes | yes | **yes** |

## Installation

```bash
npx lean-mcp
```

Then register it with Claude Code by adding this to your project's `.mcp.json`:

```json
{
  "mcpServers": {
    "lean-mcp": {
      "command": "npx",
      "args": ["lean-mcp"]
    }
  }
}
```

For Claude Desktop, add the same block to your `claude_desktop_config.json`.
See [docs/GETTING-STARTED.md](docs/GETTING-STARTED.md) for full setup.

## Quick start

1. Add the `.mcp.json` snippet above to your project root.
2. Restart Claude Code (or Claude Desktop).
3. Confirm `lean-mcp` is listed as a connected server.
4. Run your usual workflow — no changes needed.
5. Inspect savings at any time with `get_session_stats` or
   `get_cache_stats`.

## Documentation

- [Architecture](docs/ARCHITECTURE.md) — the 6 layers in detail
- [Getting started](docs/GETTING-STARTED.md) — install, configure, verify
- [Contributing](docs/CONTRIBUTING.md) — dev setup and PR process
- [Roadmap](docs/ROADMAP.md) — what ships when

## License

MIT — see [LICENSE](LICENSE).
