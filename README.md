# looprail

Looprail runs your coding agent in a loop until the work is actually done, not
until the model stops talking. You write down what "done" means (a goal, the
roles that pursue it, the checks that prove it, and the budget it runs under),
and looprail drives any agent CLI through that loop and stops when the checks
pass or a budget runs out.

It works with the agent CLIs you already have installed and logged into:
Claude Code, Codex, aider, GitHub Copilot, or any shell command. No API keys go
into looprail. If `claude` works in your terminal, looprail works.

```bash
npx looprail init      # detect your agents, scaffold a looprail.yaml
npx looprail run       # run the loop, watch it work, stop when verified
```

## Why

A single prompt to an agent gives you one shot. You read the result, notice it
missed something, and prompt again. Looprail is the part you were doing by hand:
plan the work, do it, check it, feed the failures back, and try again, with a
hard ceiling on iterations and spend so a bad loop can't run away.

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

## The Loopfile

A loop lives in a `looprail.yaml`. Here is a small one that fixes failing tests:

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

## Roles

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

## Mixing models

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

## Commands

| Command | What it does |
| --- | --- |
| `looprail init` | Detect installed agents and scaffold a `looprail.yaml` |
| `looprail run [file]` | Run the loop with live progress and a cost report |
| `looprail doctor` | Show which agent CLIs are installed and logged in |
| `looprail lint <file>` | Check a Loopfile for common loop-design mistakes |
| `looprail status [runId]` | Show verdict history for a run (`--watch` to follow) |
| `looprail logs <runId> [node]` | Print node output from a past run |
| `looprail explain <file> <node>` | Show exactly what a node would be sent |
| `looprail replay <runId>` | Re-run with cached results; edit one prompt, only the rest re-runs |
| `looprail resume <runId>` | Continue an interrupted run |

## Rails

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
moment it would go over budget rather than one expensive step later. Every run
is journaled to `.looprail/runs/<id>/journal.jsonl`, which is what powers
`status`, `logs`, `resume`, and `replay`.

## Verdict policies

How the checks combine into a pass or fail:

- `all-pass` (default): every check must pass.
- `{ quorum: N }`: at least N checks must pass.
- `{ weighted: 0.7 }`: the pass weight over the total weight must clear the
  threshold. Give a node more weight with `weight: 2`.

## Install

Looprail needs Node 20 or newer.

```bash
npm install -g looprail      # or run it with npx looprail <command>
```

You also need at least one agent CLI installed and logged in. Run
`looprail doctor` to see what it found.

## How it works

The engine is small and boring on purpose. Each iteration walks the graph in
dependency order and runs independent nodes at the same time. Verifying nodes
return a structured verdict with evidence. A router collects the verdicts and
decides whether the run is verified, should try again with the failures fed
back, should re-plan because it has stalled, or should halt because a rail was
hit. Config mistakes (a critic pointed at missing work, an unregistered agent)
halt loudly instead of quietly burning iterations. Transient adapter failures
retry with backoff before they count against the loop.

There is a small TypeScript SDK behind the CLI if you want to build loops in
code instead of YAML. The YAML compiles to the same objects the SDK builds, so
anything the CLI can run, the SDK can too. See
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the internals.

## Status

The engine, the CLI, the adapters, and the Loopfile format are here and tested.
A local web dashboard and a benchmarking harness for comparing loop designs are
on the roadmap.

## Contributing

Bug reports and pull requests are welcome. See
[CONTRIBUTING.md](CONTRIBUTING.md) for how to set up the project and run the
tests.

## License

MIT. See [LICENSE](LICENSE).
