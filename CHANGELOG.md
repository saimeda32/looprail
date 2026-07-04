# Changelog

## 0.1.0

First release.

Engine:

- Runs a loop as a graph of role nodes (planner, executor, tester, critic,
  judge, gate, synthesizer) and iterates until the checks pass or a budget
  runs out.
- Verdict router decides verified, retry, re-plan, or halt from the checks.
- Rails for iterations, cost, wall-clock time, stalls, and re-plans, checked
  before a node runs rather than after.
- Verdict policies: all-pass, quorum, and weighted.
- Stall detection that re-plans when the same failures repeat.
- Every run journaled to disk, with resume and replay from a cached prefix.
- Loopfile (`looprail.yaml`) parser and a linter for common loop-design
  mistakes.

Agents:

- Adapters for Claude Code, Codex, aider, GitHub Copilot, any shell command,
  and a mock adapter for tests.
- Agent detection so `init` and `doctor` can see what you have installed.
- Retry with backoff on transient failures; auth and config errors halt with
  a clear message instead of burning iterations.

CLI:

- `init`, `run`, `doctor`, `lint`, `status`, `logs`, `explain`, `resume`, and
  `replay`.
- Live progress and a per-agent cost report while a run is going.
- `init` asks which tier (strong, medium, cheap) to run each role on, with a
  recommended default, instead of guessing or silently picking one for you.
- Six built-in templates: `fix-tests`, `research-report`, `refactor`,
  `content-pipeline`, `review-diff`, `build-app`.

Dashboard:

- `looprail ui` opens a local, self-contained dashboard for a run: a DAG with
  live status per node, streaming output as an agent produces it, a
  live-output tab switcher for concurrent nodes, and a spend-by-agent table
  broken out by tokens and cost.
- `looprail ui --all` (mission control) shows every run across every
  registered project in one place, plus a time-range filter (24h/7d/30d/all)
  and a combined usage strip (workspaces, runs, running, total cost, total
  tokens). Registered projects are discovered automatically the first time
  you run a loop in them.
- Presence-only detection of recent raw Claude Code sessions (never reads
  their content) alongside looprail's own runs, so mission control shows the
  full picture of what's running on the machine.

Run history:

- Every run journals to `~/.looprail/runs/`, keyed by a hash of the
  project's path, the same way Claude Code keeps `~/.claude` outside your
  repo. History survives a deleted or moved project, and your project
  directory never gets a stray `.looprail/` folder.

MCP server:

- `looprail mcp` runs looprail as a Model Context Protocol server over
  stdio, for Claude Desktop, Cursor, or VS Code's Copilot Chat: lint a
  loopfile, start a run, check on it, and see what a node would receive as
  context, without leaving the chat.
- Gate nodes pause a run for a human yes or no; `approve_gate` answers one
  from inside the same chat, and `run_status` reports every gate currently
  waiting on an answer.

Benchmarks:

- `looprail bench` runs two or more named loop configs against the same
  task and reports pass rate, iterations to verified, cost, and wasted
  executor spend, so a looprail config can be measured against a naive
  single-prompt baseline instead of assumed to be better.
- A public `benchmarks/` suite with three fixtures comparing a self-judging
  baseline against a cross-model-panel looprail config.
