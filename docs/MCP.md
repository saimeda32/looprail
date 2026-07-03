# looprail as an MCP server

`looprail mcp` starts looprail as a [Model Context Protocol](https://modelcontextprotocol.io)
(MCP) server over stdio. Claude Desktop, Cursor, and VS Code's GitHub
Copilot Chat all know how to spawn a local MCP server as a child process and
talk to it over stdin/stdout — once you register looprail as one, you can
lint a loopfile, start a run, check on it, and see what a node would receive
as context, all from inside the chat you're already in, without switching to
a terminal.

This is a normal `looprail` install talking a second protocol, not a second
product. `looprail mcp` runs the exact same engine, adapters, and journal as
`looprail run`/`looprail status` — it just exposes them as MCP tools instead
of CLI subcommands.

## What's exposed

| Tool | What it does |
| --- | --- |
| `lint_loopfile` | Parse and statically validate a loopfile; returns findings |
| `run_loop` | Lint and start a run in the background; returns a `runId` immediately |
| `run_status` | Read a run's current status/iteration/cost from its journal |
| `list_runs` | List runs under a directory's `.looprail/runs`, most recent first |
| `explain_node` | Dry-run what context a node would receive, without running anything |
| `list_workspaces`\* | List every project registered with looprail mission control |

\* Only present once mission control's workspace registry has shipped
(`looprail workspace add`). If your build doesn't have it yet, every other
tool still works — `list_runs` just stays scoped to one directory at a time.

A run started through `run_loop` keeps running for as long as the `looprail
mcp` process the host started stays alive, which is for as long as you keep
that host (and its connection to looprail) open — exactly like `looprail
run` keeps running for as long as its terminal is open. Ask your assistant
to check on it with `run_status` any time; it reads straight from the run's
journal, the same file `looprail status` reads.

## Claude Desktop

Edit Claude Desktop's config file:

- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "looprail": {
      "command": "looprail",
      "args": ["mcp"]
    }
  }
}
```

If `looprail` isn't on Claude Desktop's `PATH` (it spawns servers with a
minimal environment), point `command` at the absolute path from `which
looprail`, or run it through `npx`:

```json
{
  "mcpServers": {
    "looprail": {
      "command": "npx",
      "args": ["-y", "looprail", "mcp"]
    }
  }
}
```

Restart Claude Desktop after saving. Look for the tools icon in the chat box
to confirm looprail's tools loaded.

## Cursor

Cursor uses the same config shape as Claude Desktop. Add it to
`~/.cursor/mcp.json` to make it available in every project, or to
`.cursor/mcp.json` inside one project:

```json
{
  "mcpServers": {
    "looprail": {
      "command": "looprail",
      "args": ["mcp"]
    }
  }
}
```

Open Cursor's Settings → MCP to confirm looprail shows up and is enabled.

## VS Code (GitHub Copilot Chat)

Add `.vscode/mcp.json` to your workspace (or run "MCP: Add Server" from the
command palette, which writes the same file):

```json
{
  "servers": {
    "looprail": {
      "command": "looprail",
      "args": ["mcp"]
    }
  }
}
```

VS Code's schema uses `servers`, not `mcpServers` — same tool, a different
host's config shape. Open Copilot Chat, switch to agent mode, and
looprail's tools appear alongside VS Code's built-in ones.

## Working directory

Every tool takes an optional `cwd` argument; when omitted, it defaults to
the directory `looprail mcp` was started in (for all three hosts above,
that's wherever the host itself launched the process — usually your open
project's root). Pass `cwd` explicitly to ask about a different project than
the one the host started looprail in.
