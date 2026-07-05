```
██╗      ██████╗  ██████╗ ██████╗ ██████╗  █████╗ ██╗██╗
██║     ██╔═══██╗██╔═══██╗██╔══██╗██╔══██╗██╔══██╗██║██║
██║     ██║   ██║██║   ██║██████╔╝██████╔╝███████║██║██║
██║     ██║   ██║██║   ██║██╔═══╝ ██╔══██╗██╔══██║██║██║
███████╗╚██████╔╝╚██████╔╝██║     ██║  ██║██║  ██║██║███████╗
╚══════╝ ╚═════╝  ╚═════╝ ╚═╝     ╚═╝  ╚═╝╚═╝  ╚═╝╚═╝╚══════╝
```

**Run your coding agent in a loop until the work is verified done - not until the model stops talking.**

[![npm version](https://img.shields.io/npm/v/looprail.svg)](https://www.npmjs.com/package/looprail)
[![node](https://img.shields.io/node/v/looprail.svg)](https://nodejs.org)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

You write down what "done" means (a goal, the roles that pursue it, the
checks that prove it, and the budget it runs under), and looprail drives any
agent CLI through that loop and stops when the checks pass or a budget runs
out.

It works with the agent CLIs you already have installed and logged into:
Claude Code, Codex, aider, GitHub Copilot, or any shell command. No API keys go
into looprail. If `claude` works in your terminal, looprail works.

```bash
npm install -g looprail
looprail init          # detect your agents, scaffold a looprail.yaml
looprail run           # run the loop, watch it work, stop when verified
```

The rest of this document is in two parts. **Using looprail** is a how-to:
install it, run a loop, read the commands. **What looprail does** is the
concept underneath: why loops need a verifier, how to mix models, what the
dashboard shows you while a loop runs.

---

## Using looprail

### Install

Looprail needs Node 20 or newer.

```bash
npm install -g looprail
```

You also need at least one agent CLI installed and logged in. Run
`looprail doctor` to see what it found.

Want to work on looprail itself, or run unreleased code straight from
`main`? See [CONTRIBUTING.md](CONTRIBUTING.md) for the git-clone setup.

### Quickstart

```bash
looprail init            # detects your agents, scaffolds looprail.yaml
looprail run             # runs it, shows live progress, stops when verified
looprail run --ui        # same, but opens a live dashboard alongside it
```

`looprail run --ui` opens this - the DAG updates live as each node runs,
streaming the agent's own output as it's produced:

```
  iteration 2/8   $0.34 / $10.00   12.4k tok   0 replans

  ┌───────────────┐     ┌───────────────┐     ┌───────────────┐
  │ fix           │────▶│ test          │────▶│ review        │
  │ ● executor    │     │ ● tester      │     │ ◐ critic      │
  │   passed      │     │   exit 0      │     │   running...  │
  └───────────────┘     └───────────────┘     └───────────────┘
```

`init` picks a template for you (`fix-tests`, `research-report`, `refactor`,
`content-pipeline`, `review-diff`, or `build-app`) and fills in whichever
agent CLIs it found. For each role in the template it asks which tier to run
on, strong, medium, or cheap, with a sensible default already highlighted, so
you decide the cost/quality tradeoff per role instead of guessing at YAML by
hand. Pass `--yes` to accept every recommended default with zero prompts, or
`--template <name> --agent <adapter>` to skip detection entirely.

Prefer to start from a real file instead of a wizard? Every template also
exists as a standalone example under [`examples/`](examples/) - each one
has its own README explaining what it demonstrates and what to change,
ready to `cp` into your project.

### Writing a Loopfile

A loop lives in a `looprail.yaml`. Here is a small one that fixes failing
tests:

```yaml
name: fix-tests
goal: |
  Make the test suite pass without weakening any assertion.
  Done means: npm test exits 0.

agents:
  worker:   { adapter: claude-code, model: sonnet }
  reviewer: { adapter: codex }            # a different model reviews the work

graph:
  fix:    { role: executor, agent: worker }
  test:   { role: tester, after: fix, run: npm test, expect: exit 0 }
  review: { role: critic, agent: reviewer, of: fix, after: fix,
            prompt: Did the fix weaken or delete any assertion? }

rails:
  max_iterations: 8
  max_cost_usd: 10
  stall_after: 3          # 3 identical failures in a row means re-plan

verdict: { policy: all-pass }
```

Run it:

```bash
looprail run fix-tests.yaml
```

Looprail runs the executor, runs the tests, has the reviewer look for weakened
assertions, and if either check fails it feeds the actual failure back into the
next attempt. It stops when both pass, or when it hits eight iterations or ten
dollars, whichever comes first.

### Commands

| Command | What it does |
| --- | --- |
| `looprail init` | Detect installed agents and scaffold a `looprail.yaml` |
| `looprail run [file]` | Run the loop with live progress and a cost report |
| `looprail bench [file]` | A/B two or more named loop configs against the same task and report measured deltas (`benchmarks/`) |
| `looprail run --ui` | Same, and open a live dashboard for this run |
| `looprail ui [runId]` | Open the dashboard for a run (defaults to the latest) |
| `looprail ui --all` | Open mission control: every run, across every registered project |
| `looprail doctor` | Show which agent CLIs are installed and logged in |
| `looprail lint <file>` | Check a Loopfile for common loop-design mistakes |
| `looprail status [runId]` | Show verdict history for a run (`--watch` to follow) |
| `looprail logs <runId> [node]` | Print node output from a past run |
| `looprail explain <file> <node>` | Show exactly what a node would be sent |
| `looprail replay <runId>` | Re-run with cached results; edit one prompt, only the rest re-runs |
| `looprail resume <runId>` | Continue an interrupted run |
| `looprail workspace add [path]` | Register a project so its runs show up together (defaults to cwd) |
| `looprail workspace list` | Show every registered project |
| `looprail workspace remove <path>` | Stop tracking a project |
| `looprail mcp` | Start looprail as an MCP server for Claude Desktop, Cursor, or VS Code |

You rarely need `workspace add` yourself - `looprail run` registers its own
project the first time you use it there.

`looprail mcp` lets you do the same things - lint a loopfile, start a run,
check on it - from inside Claude Desktop, Cursor, or VS Code's Copilot Chat
instead of a terminal. See [docs/MCP.md](docs/MCP.md) for the config
snippet each host needs and the full list of tools it exposes.

---

## What looprail does

### Why a loop needs a verifier

A single prompt to an agent gives you one shot. You read the result, notice it
missed something, and prompt again. Looprail is the part you were doing by
hand: plan the work, do it, check it, feed the failures back, and try again,
with a hard ceiling on iterations and spend so a bad loop can't run away.

Two ideas do most of the work:

- **The verifier is the point.** A loop is only as honest as the check that
  ends it. "Make the tests pass" is a good goal because a test runner can prove
  it. "Improve the code" is a bad one because nothing can. Looprail makes you
  name the check up front and refuses to run a loop that has no way to verify
  itself.
- **Don't let a model grade its own work.** You can send the executor's output
  to a different model, or a different provider, for review. A critic panel
  made of Claude, Codex, and a local model catches things three copies of one
  model never will.

### Roles

Every node in the graph plays one role:

| Role | What it does |
| --- | --- |
| `planner` | Breaks the goal into a plan with checkable success criteria |
| `executor` | Does the work through an agent |
| `tester` | Runs a real command; passes on exit 0 |
| `critic` | Attacks the work and looks for real flaws; can run as a panel |
| `judge` | Scores the work against a rubric and a threshold |
| `gate` | Pauses for a human yes or no before the loop can finish |
| `synthesizer` | Merges the output of a fan-out back into one result |

Planning and execution are just regions of the same graph. Planners and their
critics run first and can revise the plan a few rounds before any work starts.
Everything else iterates until the verdict comes back clean.

### Self-planning loops

You don't always have to write the graph yourself. A planner node with
`generates: graph` proposes one from a plain-English goal instead of prose:

```yaml
agents:
  planner:  { adapter: claude-code, model: opus }
  reviewer: { adapter: codex }              # different model, catches what the planner's own review misses

graph:
  plan:    { role: planner, agent: planner, generates: graph,
             prompt: Propose a graph of nodes that would implement the goal above. }
  review:  { role: critic, agent: reviewer, of: plan, after: plan }
  approve: { role: gate, after: review }    # pauses for you before anything the plan proposes actually runs
```

The planner's reply is parsed as a loopfile fragment, reviewed by a
different model, and spliced into the live graph only after the `approve`
gate lets it through - reject or edit it there if it's wrong, rather than
rubber-stamping it. See [`examples/self-planning`](examples/self-planning)
for a runnable version. On a re-plan, the planner can reply with a compact
`edits:` block targeting just what changed instead of re-emitting the whole
graph, which cuts the output-token cost of a retry by 80%+ on a typical fix.

### Agent permissions

Each agent's `permissions` picks how much it's allowed to do on its own,
independent of which model it runs:

```yaml
agents:
  worker: { adapter: claude-code, model: sonnet, permissions: safe }
```

`safe` accepts edits but asks before anything riskier; `standard` runs
without asking; `full` skips the adapter's own sandboxing entirely. Leaving
`permissions` unset reproduces each adapter's own pre-existing default
(`safe` for claude-code/codex/aider; `full` for copilot-cli, which had no
sandboxed mode to begin with) - set it explicitly rather than relying on
that, since `full` is real reduced safety, not just less prompting.

### Mixing models

Each node picks which agent runs it, so you can shape a loop by cost and by
independence:

```yaml
agents:
  builder: { adapter: claude-code, model: opus }   # expensive, rare
  checker: { adapter: claude-code, model: haiku }  # cheap, frequent
  skeptic: { adapter: codex }                       # different provider
  local:   { adapter: shell, command: "ollama run llama3 {prompt}" }

graph:
  draft: { role: executor, agent: builder }
  crit:  { role: critic, of: draft, after: draft, panel: [checker, skeptic, local] }
  judge: { role: judge, agent: skeptic, after: crit, threshold: 0.85 }
```

A critic panel with one critic per provider gives you three different blind
spots instead of one. `looprail lint` warns when a judge uses the same model as
the executor it is grading.

Looprail doesn't drive every agent tool the same way. Claude Code, Codex,
aider, and GitHub Copilot each have a real command-line mode looprail can
shell out to and parse output from, so any of them can run any node. Cursor
doesn't have that (it's an IDE, not a scriptable process), so it can't be
assigned a node - the only way Cursor or Claude Desktop connect to looprail is
the other direction, as an MCP client calling into looprail's own tools via
`looprail mcp` (see [docs/MCP.md](docs/MCP.md)).

### Rails

Rails are the ceiling on a run. All of them are optional except the first two:

```yaml
rails:
  max_iterations: 8       # stop after N passes through the loop
  max_cost_usd: 10        # stop before spending more than this
  max_wall_minutes: 60    # stop after this much wall-clock time
  stall_after: 3          # N identical failures in a row triggers a re-plan
  replan_limit: 2         # give up after this many re-plans
  gate_timeout: 300       # seconds to wait on a human gate before halting
```

Looprail checks a rail before it starts a node, not after, so a loop halts the
moment it would go over budget rather than one expensive step later. A
misconfigured loop (a critic pointed at work that doesn't exist, an
unregistered agent) halts loudly and immediately instead of quietly burning
iterations trying to recover from something that will never fix itself.

### Benchmarks

`looprail bench <benchfile>` runs two or more named loop configs against the
same task, N times each, and reports pass rate, iterations to verified, cost,
wall time, and a wasted-work estimate per config, plus a one-line verdict:

```bash
looprail bench benchmarks/bug-fix-on-seeded-repo.bench.yaml
```

A benchfile names a task and points at ordinary loopfiles, one per config, so
nothing about a loop's definition changes to be benchmarked. Every report
labels each config's numbers `mock` or `real` based on which adapters
actually ran, and the three benchmarks committed under `benchmarks/` are
mock-backed, so `npm test` proves the whole harness end to end for free. See
[benchmarks/README.md](benchmarks/README.md) for reading the report and
running the same fixtures against real agents.

### Verdict policies

How the checks combine into a pass or fail:

- `all-pass` (default): every check must pass.
- `{ quorum: N }`: at least N checks must pass.
- `{ weighted: 0.7 }`: the pass weight over the total weight must clear the
  threshold. Give a node more weight with `weight: 2`.

### Watching a run

Every run is journaled to `~/.looprail/runs/<workspace>/<id>/journal.jsonl` as
it happens, the same way Claude Code keeps its own session history under
`~/.claude` rather than inside your repo - your project directory never gets
a stray `.looprail/` folder, and a run's history survives even if you delete
or move the project. This is what `status`, `logs`, `resume`, `replay`, and
the dashboard all read from. `looprail run --ui` (or `looprail ui` for a past
run) opens a local page
showing the DAG live: which node is running, which have passed or failed, and
a per-node output panel you can click into. When a node is still running, its
output streams into that panel as the agent produces it - no "please wait,"
you watch it write. If more than one node is running at once (a critic panel,
say), a tab switcher lets you flip between watching each one live. Cost,
iteration count, and elapsed wall time all show as running totals against
your rails, broken down per agent so a three-way critic panel shows you
exactly which model is expensive, not just a combined number. Zoom/pan
controls (buttons, ctrl+wheel, click-drag) keep a dense or deep self-planned
graph legible instead of squeezed to fit.

A `gate` node pauses the run right there in the browser - approve, reject
with feedback, or cancel from the page itself, no need to switch back to the
terminal. A halted run's dashboard also lets you resume in place with raised
rails (`max_iterations`, `max_cost_usd`, `max_wall_minutes`, `replan_limit`)
or an edited goal, the same overrides `looprail resume` takes as flags.

Every project you run a loop in registers itself automatically, so looprail
knows about it without any setup on your part.

### Mission control

If you're running loops in more than one project, `looprail ui --all` opens
one dashboard for all of them at once, instead of one at a time. Every run
across every registered project shows up as a card, and clicking into one
gets you the same live per-run dashboard `looprail ui` shows, streaming
output and all.

Projects register themselves the moment you `looprail run` there, so most of
the time there's nothing to set up. You can also manage the list by hand:

```bash
looprail workspace add        # register the current directory
looprail workspace add ~/code/finch
looprail workspace remove ~/code/finch
looprail workspace list
```

Mission control also shows a lightweight presence indicator for raw Claude
Code sessions, separate from looprail runs, in any project you've
registered. If you're just working in Claude Code directly, without going
through `looprail run`, you'll see a card that says a session is active
there and when it was last active. That's it: presence only, no verdict, no
cost, no iteration count, because a raw session was never run through a
loop and never produced anything looprail can verify.

### How it works

The engine is small and boring on purpose. Each iteration walks the graph in
dependency order and runs independent nodes at the same time. Verifying nodes
return a structured verdict with evidence. A router collects the verdicts and
decides whether the run is verified, should try again with the failures fed
back, should re-plan because it has stalled, or should halt because a rail was
hit. Config mistakes halt loudly instead of quietly burning iterations.
Transient adapter failures retry with backoff before they count against the
loop.

There is a small TypeScript SDK behind the CLI if you want to build loops in
code instead of YAML. The YAML compiles to the same objects the SDK builds, so
anything the CLI can run, the SDK can too. See
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the internals.

## Status

The engine, the CLI, the adapters, the Loopfile format, and the `bench` A/B
harness are here and tested. Self-planning loops (`generates: graph`) and
per-agent permission presets are here too. The dashboard is here, with live
streaming output, in-browser gate approval and resume, and a live wall-time
gauge, in both a single-run view (`looprail ui`) and a mission-control view
across every registered project (`looprail ui --all`). `looprail mcp` runs
looprail as an MCP server for Claude Desktop, Cursor, and VS Code's Copilot
Chat. See `benchmarks/` for three mock-backed benchmarks comparing a naive
prompting baseline against an engineered looprail config, and
`benchmarks/README.md` for running the same comparison against real agents.

## Contributing

Bug reports and pull requests are welcome. See
[CONTRIBUTING.md](CONTRIBUTING.md) for how to set up the project and run the
tests.

## License

MIT. See [LICENSE](LICENSE).
