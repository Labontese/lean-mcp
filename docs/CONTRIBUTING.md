# Contributing

Thanks for considering a contribution. `lean-mcp` is deliberately small and
opinionated — a few rules keep it that way.

## Dev setup

```bash
git clone https://github.com/Labontese/lean-mcp.git
cd lean-mcp
npm install
npm test
```

All commands:

| Command | What it does |
|---------|--------------|
| `npm run build` | Compile TypeScript to `dist/` |
| `npm run dev` | Watch-mode dev server via `tsx` |
| `npm test` | Run the Vitest suite |
| `npm run lint` | Check source with Biome |
| `npm run format` | Auto-format source with Biome |

## Testing requirements

- Tests use [Vitest](https://vitest.dev). Globals (`describe`, `it`, `expect`)
  are enabled via `vitest.config.ts`.
- **Every layer must have its own test file** in `tests/` — see
  `tests/l1.test.ts` as the canonical shape.
- The `tests/integration.test.ts` file covers the wired-up server.
- New features land with tests in the same PR. CI (`.github/workflows/ci.yml`)
  runs `npm run lint` and `npm test` on every push and PR, on Node 22.

## Linting and formatting

We use [Biome](https://biomejs.dev) for both linting and formatting
(`biome.json`). Run `npm run lint` before committing. Run `npm run format` to
apply auto-fixes.

The Biome config uses:

- `indentStyle: space`
- `indentWidth: 2`
- `linter.rules.recommended: true`

## Commit messages

We follow [Conventional Commits](https://www.conventionalcommits.org/):

- `feat: ...` — a new user-visible feature
- `fix: ...` — a bug fix
- `docs: ...` — documentation only
- `refactor: ...` — internal change, no behavior change
- `test: ...` — new or updated tests
- `chore: ...` — tooling, deps, CI

Scope the message to a single concern. A one-line subject plus an optional
body is usually enough.

## Pull requests

1. Fork and branch from `main`. Branch names use a short prefix:
   `feat/...`, `fix/...`, `docs/...`.
2. Keep PRs focused — one concern per PR.
3. Ensure `npm run lint` and `npm test` pass locally.
4. Include or update tests for any code change.
5. Update relevant docs (`README.md`, `docs/ARCHITECTURE.md`) when you change
   public behavior or layer contracts.
6. Open the PR against `main`. The CI workflow runs automatically.
7. A maintainer reviews, requests changes if needed, and squash-merges when
   approved.

## Changing a layer interface

Layer interfaces (for example the `ToolRegistry` contract in
`src/types/index.ts`) are contracts between layers. Changing one affects
multiple layers and tests. Open an issue describing the change before writing
the PR, so the design discussion happens once and up front.

## Reporting issues

Use the GitHub issue templates under
[`.github/ISSUE_TEMPLATE/`](../.github/ISSUE_TEMPLATE/):

- **Bug report** — what you did, what you expected, what you saw, environment
- **Feature request** — the problem first, your proposed solution second
