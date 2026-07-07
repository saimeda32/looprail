# Changelog

## 0.7.0

- **Probe panels (`probe: true`)** - adaptive panel depth that never weakens
  the verification guarantee. On a `panel` verifier under the `all-pass`
  policy, clone 1 runs first; if it fails, the remaining clones are skipped -
  that iteration's aggregate is already determined, so the skipped reviews
  could not have changed the iterate/stop decision. The pass path is never
  thinned: verified still requires every clone to run and pass. With
  `panel: [a, b, c]` the first listed agent leads, so put the cheapest
  reviewer first. New lint rules L011 (probe without panel) and L012 (probe
  under quorum/weighted, where one fail decides nothing) warn when probe
  silently has no effect.

- **Skill pack installable via the skills CLI** - `npx skills add
  saimeda32/looprail` now installs the bundled agent skill (Claude Code,
  Cursor, Codex, and other agents), refreshed to teach the current on-ramps
  (`demo`, `templates`, `run --dry-run`) and probe panels. A CI test now
  guards the skill against rot: every `looprail <cmd>` it names must exist
  in the CLI.
- **`looprail templates`** - list the built-in loop shapes (fix-tests,
  research-report, refactor, content-pipeline, review-diff, build-app) with
  each one's description and the agent roles it wires, so you can discover and
  pick a template without stepping through interactive `init`. `--json` emits
  the catalog for scripting.
- **Interactive `init` template picker now shows descriptions** - each choice
  reads `name - what it does` instead of a bare name, so the pick is informed.
- **`benchmarks/efficiency/`** - a deliberate, human-run, real-dollar
  engine-version A/B (`looprail@0.5.0` vs current) that prices the 0.6.0
  efficiency work on a seeded two-branch task; never run by `npm test`.
- The no-loopfile empty state now points at all three on-ramps (`init`,
  `templates`, `demo`).

## 0.6.2

- **`looprail run --dry-run`** - print the execution plan (dependency-ordered
  node groups, each step's resolved adapter/model, and the budget ceiling)
  and exit without invoking any agent or spending anything. Runs before the
  agent-availability preflight, so you can preview a loopfile while authoring
  it on a machine that hasn't installed the CLIs yet. `--json` emits the plan
  structurally.

## 0.6.1

Ease of use, accuracy, and cost-safety polish.

- **`looprail demo`** - run a full verified loop (plan -> build -> real
  test -> independent critic -> verified) on the built-in mock adapter,
  offline and instant, with no API key and nothing installed. The
  30-second "so that's what it does" before any setup.
- **Preflight adapter check** - a run now fails BEFORE spending anything
  if the loopfile needs an agent CLI that isn't installed or logged in,
  printing each missing one with its fix hint instead of billing earlier
  nodes and then dying mid-run on a raw "command not found".
- **Robust verdict parsing** - a critic's verdict block is tolerated with
  markdown bold, heading/blockquote/list prefixes, and trailing text
  (`**VERDICT: pass**`, `## VERDICT: fail`, `VERDICT: fail - reason`),
  taking the last verdict line. Fewer wasted re-ask invocations and fewer
  misreads.
- **New lint rule L010** - warns when an executor's work is verified by
  nothing downstream, catching a loop that "verifies" one branch while
  silently shipping another unchecked.


## 0.6.0

The multi-provider moat + an efficiency pass.

Multi-provider (a neutral orchestrator can mix vendors no single lab's CLI ever will):

- **Rate-limit failover.** An agent can name a `fallback:` - another agents
  key to hand its work to when the provider rate-limits it and retries are
  exhausted. Cycle-guarded, lint-checked, journaled; the result is
  attributed to the agent that actually served the call.
- **`looprail doctor --models`** live-queries each installed CLI's real
  model catalog (codex, copilot, aider, ollama), labeling each row live or
  static - no stale hardcoded tier lists.
- **`looprail route`** auto-generates adapter/model variants of your own
  loopfile, benches them under a budget, ranks best-first, and writes the
  winner to `.looprail/routing.json` - "which model is best for THIS repo",
  answered with data.
- **Three new first-class adapters**: gemini, opencode, and ollama (local
  models, real $0 cost, estimated tokens - replacing the shell workaround).
- **Per-agent `env:`** points a single agent's CLI at a caching/optimizing
  proxy without a global env change.

Efficiency (the loop sends fewer, smaller, righter calls):

- **Lineage-scoped feedback + within-run cache** - a node re-runs only when
  its own dependency lineage failed, so independent branches that passed are
  served from cache instead of rebuilt.
- **Incremental executors** revise their prior attempt instead of
  regenerating the whole artifact from the goal.
- **Tester infrastructure errors** (broken test command, module-resolution)
  halt as config errors instead of being fed to a critic as a phantom
  failure.
- **Convergence breaker** halts a plateaued loop ("not converging") instead
  of grinding to the iteration/wall rail.

Dashboard:

- Triage-first mission control (Needs-you / Running / History), parked and
  stale as first-class statuses, one-click resume, node telemetry + attempt
  pips on the graph, live-output panel that follows the graph frontier,
  multi-tool session activity (claude-code / copilot / codex / aider).


## 0.3.0

MCP:

- `run_loop` now self-registers its workspace and returns a `watchUrl` -
  the run's own mission-control link - in its response; `run_status`
  mirrors the same field for an already-known runId.
- A new `looprail_flow` MCP prompt teaches a connected IDE-chat agent the
  recommended flow (check `examples/` first, lint, run, share the watch
  URL) and the real loopfile schema itself - the actual NodeDef fields,
  roles, and rails - so it works even with no matching example, not just
  a process checklist.
- `looprail mcp` setup docs added for Claude Code (was previously only
  documented for Claude Desktop/Cursor/VS Code).

Dashboard:

- Consolidated onto a single server implementation: `run --ui`, `ui
  <runId>`, and `ui --all` all now serve through mission control's
  routing. Fixes a real staleness bug where a self-planning splice's
  extended graph never showed up in a standalone `run --ui` dashboard
  (mission control's per-run view already re-read the persisted loopfile
  fresh on every request; the standalone server never did).
- A gate's own wall-clock wait for a human answer no longer counts
  toward `max_wall_minutes` - a slow approval isn't the loop "taking too
  long to do work".
- DAG zoom-toolbar no longer drifts during pan/zoom (was a child of the
  scrolling canvas using position:sticky+float, which only worked by
  accident).
- Cost figures across the dashboard show one combined real+estimated
  total instead of a parenthetical breakdown.
- A mid-node agent-CLI permission prompt (an underlying adapter's own
  tool-approval system, distinct from a loopfile's `gate` node) can now
  be detected, surfaced in the live-output panel, and answered - relayed
  back into the exact subprocess waiting on it. Proven end-to-end against
  a mock adapter; none of the four real adapters has a detector wired up
  yet (each has a comment explaining why - live investigation couldn't
  confirm a real permission-prompt output shape to detect against without
  inventing one).

Packaging & project infrastructure:

- Published to npm: `npm install -g looprail`.
- CI (lint + typecheck + test + build) on every push/PR; CodeQL scanning;
  Dependabot (weekly, grouped dev-dependency bumps, patch-level PRs
  auto-merge once CI passes).
- GitHub Actions publishes to npm via Trusted Publisher (OIDC) on every
  GitHub Release - no stored npm token.
- Issue templates, an expanded CONTRIBUTING guide, and a README rewrite
  (wordmark banner, live npm/license badges, a supported-adapters table,
  and a real recorded demo GIF in place of the old ASCII mockup).

Examples:

- `multi-gate-approval` - two independent human sign-off points in one
  loop (approve the plan, then separately approve the result).

## 0.2.0

Engine:

- Self-planning loops: a planner node with `generates: graph` proposes a
  graph from a plain-English goal instead of prose, reviewed by a
  different model and gated behind explicit human approval before any of
  it runs.
- Compact `edits:` block for a re-planned graph: a targeted fix no longer
  has to re-emit the whole graph, cutting retry output tokens 80%+ on a
  representative fix.
- Per-agent permission presets (`safe`/`standard`/`full`), independent of
  which model an agent runs.
- Time spent waiting for a gate no longer counts toward `max_wall_minutes`
  - a slow human decision isn't the loop taking too long to do work.
- Resume can now raise `replan_limit` and override the goal text, the same
  way it already could raise `max_iterations`/`max_cost_usd`/
  `max_wall_minutes`.
- Cache exclusion on resume is now precise: only the node(s) whose output
  fed the reconstructed feedback are excluded, not every node sharing that
  iteration - already-passed independent work is no longer needlessly
  re-run.

Dashboard:

- In-browser gate approval and resume (raised rails or an edited goal),
  no need to switch back to a terminal.
- Live elapsed-wall-time gauges, both on a single run and across mission
  control's aggregate and per-tile figures.
- DAG zoom/pan controls (buttons, ctrl+wheel, click-drag).
- Cost figures show one combined real+estimated total instead of a
  parenthetical breakdown.

Examples:

- Six new copy-paste example loopfiles matching `looprail init`'s
  templates (`fix-tests`, `research-report`, `refactor`,
  `content-pipeline`, `review-diff`, `build-app`), plus a
  `multi-gate-approval` example, and a README for every example folder.

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
