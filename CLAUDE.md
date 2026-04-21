# Claude instructions for `lean-mcp`

This file tells Claude (Code or any other Claude-driven agent) how to work
inside this repository. Read it before making non-trivial changes.

## Project overview

`lean-mcp` is an MCP server that reduces token usage for Claude through six
composable optimization layers (L1–L6) plus an L0 CLI output interceptor.
See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the full picture.

- **Language**: TypeScript (`ES2022`, `NodeNext`)
- **Runtime**: Node.js 22+
- **Transport**: MCP over stdio
- **Storage**: SQLite via `better-sqlite3`
- **Test runner**: Vitest
- **Lint / format**: Biome

## Before you start

1. **Plan first.** For anything beyond a typo fix, outline the approach before
   writing code. State which layer(s) you are touching, which tests you will
   add, and any interface changes you expect. If in doubt, propose the plan
   and pause for confirmation.
2. **Read the neighbors.** Before modifying a layer, read the layer file, its
   test, the shared types in `src/types/index.ts`, and the sections of
   `docs/ARCHITECTURE.md` that describe it.
3. **Prefer subagents for wide searches.** If a task requires scanning the
   whole repo (dependency graph, usage sites, rename impact), spawn a
   subagent rather than reading files serially in the main context.

## Architecture rules

- **Layers have stable interfaces.** Do not change a layer's public contract
  (types in `src/types/index.ts`, exported class signatures) without an
  explicit discussion in the PR description. A contract change affects
  multiple layers and their tests.
- **Each layer lives in one file** under `src/layers/`. Do not split a layer
  across files without a compelling reason.
- **Layers do not import each other directly.** They communicate through
  shared types and through the `ObservabilityBus` (L6). If layer X needs
  something from layer Y, route it via the server or the event bus.
- **Storage is isolated.** Only `src/storage/db.ts` touches `better-sqlite3`.
  Everything else uses the `Storage` wrapper.
- **The server stays thin.** `src/server.ts` wires things together; it does
  not contain optimization logic.

## Testing requirements

- **Every layer has a test file** in `tests/` (`l1.test.ts`, `l2.test.ts`,
  etc.). New layers require a new test file.
- **Integration tests** live in `tests/integration.test.ts` and exercise the
  wired-up `LeanMcpServer`.
- **Run `npm test` before proposing a PR.** CI runs the same command plus
  `npm run lint` on Node 22.
- **New public behavior requires a test.** If the change is invisible to
  tests, question whether it should exist.

## Commit format

Use [Conventional Commits](https://www.conventionalcommits.org/):

- `feat(lN): ...` — a new feature in layer N (e.g. `feat(l1): ...`)
- `fix(lN): ...` — a bug fix in layer N
- `docs: ...` — documentation only
- `refactor: ...` — internal change, no behavior change
- `test: ...` — new or updated tests
- `chore: ...` — tooling, deps, CI

One concern per commit. Keep the subject under 72 characters.

## Adding a new MCP tool

The tool registry and tool definitions live in `src/tools/`. To add a tool:

1. **Define the tool** following the `ToolDefinition` interface in
   `src/types/index.ts`:
   ```ts
   import type { ToolDefinition } from '../types/index.js';

   export const myTool: ToolDefinition = {
     name: 'my_tool',
     description: 'One-line, human-readable summary',
     schema: { /* JSON Schema for args */ },
     handler: async (args) => {
       // implementation
     },
   };
   ```
2. **Register it** in `src/tools/index.ts` by adding it to the `tools` array.
3. **Write a test** under `tests/` covering at least the happy path and one
   error case.
4. **Emit an observability event** from the handler so L6 can report on it.
   Use the existing `ObservabilityEvent` shape — do not invent a new event
   type unless the change is coordinated with L6.
5. **Document it** if the tool is user-visible. A one-line entry in
   `README.md` or `docs/ARCHITECTURE.md` is usually enough.

## Self-improvement loop

If while working you notice a rule in this file that is wrong, missing, or
outdated, propose an edit to `CLAUDE.md` in the same PR. Keeping these
instructions honest is part of the job.
