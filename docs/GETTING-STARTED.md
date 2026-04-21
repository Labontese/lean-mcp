# Getting started

## Prerequisites

- **Node.js** `>= 22.0.0` (the CI pipeline runs on Node 22)
- **npm** (ships with Node) or any npm-compatible package manager
- **Claude Code** or **Claude Desktop** — the MCP client that will connect to
  `lean-mcp`

Check your Node version:

```bash
node --version
```

## Install

### Option A — via `npx` (recommended)

No install step is needed. `npx` will fetch the latest published version on
first run. Go straight to the configuration section below.

### Option B — global npm install

```bash
npm install -g lean-mcp
```

### Option C — from source

```bash
git clone https://github.com/Labontese/lean-mcp.git
cd lean-mcp
npm install
npm run build
```

Then point your client at the local `dist/index.js` instead of `npx lean-mcp`.

## Configure Claude Code

Add a `.mcp.json` file to your project root (or edit the existing one):

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

Restart Claude Code. The server appears under the MCP servers list.

## Configure Claude Desktop

Open your `claude_desktop_config.json`:

- **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`
- **Linux**: `~/.config/Claude/claude_desktop_config.json`

Add the same `mcpServers` block as above, then restart Claude Desktop.

## Smoke test

After restart, in a Claude Code or Desktop session, ask:

> "List the tools exposed by the `lean-mcp` server."

You should see the meta-tools from L1 (`search`, `describe`, `execute`) and
the L6 report tool (`lean_mcp_report`). Running `lean_mcp_report` should return
a (possibly empty) per-layer breakdown.

If you run `lean-mcp` manually in a terminal you should see:

```
lean-mcp server running
```

on stderr. The process then waits for MCP messages on stdin.

## Common problems

### "command not found: npx"

Install Node 22+. `npx` ships with npm which ships with Node.

### Server shows up but has no tools

Make sure you restarted the Claude client after editing `.mcp.json`. The client
only reads this file on startup.

### `better-sqlite3` build fails on install

`better-sqlite3` is a native module. On Windows you may need the
Visual Studio Build Tools; on macOS you need Xcode Command Line Tools; on
Linux you need `python3`, `make`, and a C++ compiler. Re-run
`npm install` after installing the required toolchain.

### Port already in use

`lean-mcp` doesn't bind a TCP port — it speaks MCP over stdio. If you see a
port error it is coming from a different process, not this server.

## Next steps

- Read the [architecture overview](ARCHITECTURE.md) to understand what each
  layer does.
- Read [CONTRIBUTING](CONTRIBUTING.md) if you want to hack on the source.
- Read the [roadmap](ROADMAP.md) to see what's coming.
