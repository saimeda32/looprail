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
