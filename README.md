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

[Quickstart](#quickstart) · [Commands](#commands) · [Loopfile reference](docs/loopfile-reference.md) · [How it works](#how-it-works) · [Comparison](#how-looprail-compares)

A `looprail.yaml` declares what "done" means - a goal, the roles that pursue
it, the checks that prove it, and the budget it runs under - and looprail
drives any agent CLI through that loop until the checks pass or a budget runs
out. It works with the agent CLIs you already have installed and logged into:
Claude Code, Codex, Antigravity (Gemini), aider, GitHub Copilot, opencode,
local models via ollama, or any shell command. No API keys go into looprail.

![looprail dashboard: a gate awaiting approval, then executing, then verified](docs/assets/demo.gif)

## Why

- **Agents claim done when they aren't.** Left to judge itself, a model stops
  when it stops talking. Looprail stops when a real command exits 0 or an
  independent review passes - and feeds every failure back into the next attempt.
- **Prompt rules don't hold.** "Verification is mandatory" in a CLAUDE.md is
  an instruction the agent can rationalize past; a tester node running in the
  engine and a critic on a different model are not.
- **The verifier is the point.** You name the check up front, and looprail
  refuses to run a loop that has no way to verify itself.
- **Don't let a model grade its own work.** A Claude worker checked by a Codex
  critic; a panel with one critic per provider catches what three copies of
  one model never will. ([benchmarks](docs/BENCHMARKS.md))
- **Looprail is not an agent.** It writes no code and has no model of its own.
  It's the loop AROUND the agents you already use - the re-prompting and
  re-testing you'd otherwise do by hand.

## Install

Needs Node 20 or newer, plus at least one agent CLI installed and logged in.

```bash
npm install -g looprail
looprail doctor          # shows which agent CLIs it found installed and logged in
```

## Quickstart

No keys, nothing installed, nothing touched - `demo` runs a full verified
loop on the built-in mock adapter in about five seconds:

```bash
npx looprail demo
```

Then the real path, in your own project:

```bash
looprail init            # detects your agents, scaffolds looprail.yaml
looprail run --dry-run   # print the plan - node order, models, budget - spend nothing
looprail run             # run the loop, watch it work, stop when verified
```

A run ends with a verdict and the accounting, not a transcript:

```
verified - all verifiers passed
  iterations: 1 · replans: 0 · total cost: $0.00
  100% test (tester)  exit 0
  journal: ~/.looprail/runs/<workspace>/<run-id>/journal.jsonl
```

`looprail run --ui` opens the same run as a live dashboard. Here's a real
one: a genuinely buggy function with a failing test, handed to real Claude
Code through a fix → `node test.js` → independent-critic loop, verified in
one iteration with per-node cost and tokens on screen:

![looprail dashboard showing a real Claude Code fix, verified, with real cost and token counts](docs/assets/real-demo-verified.png)

## Loopfile anatomy

```yaml
name: fix-tests
goal: |
  Make the test suite pass without weakening any assertion.
  Done means: npm test exits 0.

protect: tests             # tests + framework configs are hashed; editing them fails the iteration
ledger: true               # every verdict lands in a hash-chained, committable audit file

agents:
  worker:   { adapter: claude-code, model: sonnet }
  reviewer: { adapter: codex }             # a different model reviews the work

graph:
  fix:    { role: executor, agent: worker }
  test:   { role: tester, after: fix, run: npm test, expect: exit 0 }
  review: { role: critic, agent: reviewer, of: fix, after: test,
            blind: true,                   # reviews the real workspace diff, not the worker's story
            prompt: Did the fix weaken or delete any assertion? }

rails:
  max_iterations: 8        # hard ceiling on passes through the loop
  max_cost_usd: 10         # stop before spending more than this
  stall_after: 3           # 3 identical failures in a row means re-plan

verdict: { policy: all-pass }
```

Looprail runs the executor, runs the tests, has the reviewer inspect the
actual diff, and feeds any failure back into the next attempt - until both
checks pass or a rail is hit. Every field, role, rail, and verdict policy:
[docs/loopfile-reference.md](docs/loopfile-reference.md).

## Commands

| Command | What it does |
| --- | --- |
| `looprail demo` | Run a full verified loop on the built-in mock adapter - no API key, nothing installed |
| `looprail templates` | List the built-in loop shapes (fix-tests, refactor, build-app, review-diff, …) and the agents each one wires |
| `looprail init` | Detect installed agents and scaffold a `looprail.yaml` |
| `looprail init --from-spec prd.md` | Scaffold a self-planning loop that implements a written spec, with requirement-coverage review and a plan-approval gate |
| `looprail run [file]` | Run the loop with live progress and a cost report |
| `looprail run --dry-run` | Print the execution plan (node order, per-node model, budget ceiling) and exit - invokes no agent, spends nothing |
| `looprail ledger` | Inspect the repo's hash-chained evidence ledger of verdicts; `--verify` recomputes the chain and names any break |
| `looprail spend` | Per-provider/model spend across every run, from the journals - real cost and estimates kept separate |
| `looprail bench [file]` | A/B two or more named loop configs against the same task and report measured deltas (`benchmarks/`) |
| `looprail route [file]` | Benchmark auto-generated adapter/model variants of your own loopfile and record the best mix in `.looprail/routing.json` |
| `looprail run --ui` | Same, and open a live dashboard for this run |
| `looprail run -d` | Detached: the run survives your terminal; watch it and answer its gates from mission control |
| `looprail queue [file]` | Run a list of goals unattended, sequentially; wake up to a triage table (verified / parked / halted) |
| `looprail ui [runId]` | Open the dashboard for a run (defaults to the latest) |
| `looprail ui --all` | Open mission control: every run, across every registered project |
| `looprail doctor` | Show which agent CLIs are installed and logged in |
| `looprail doctor --models` | List the models each installed CLI can run, live-queried where the CLI allows it (`--json` for scripts) |
| `looprail lint <file>` | Check a Loopfile for common loop-design mistakes |
| `looprail status [runId]` | Show verdict history for a run (`--watch` to follow) |
| `looprail logs <runId> [node]` | Print node output from a past run |
| `looprail explain <file> <node>` | Show exactly what a node would be sent |
| `looprail replay <runId>` | Re-run with cached results; edit one prompt, only the rest re-runs |
| `looprail resume <runId>` | Continue an interrupted run |
| `looprail workspace add [path]` | Register a project so its runs show up together (defaults to cwd) |
| `looprail workspace list` | Show every registered project |
| `looprail workspace remove <path>` | Stop tracking a project |
| `looprail mcp` | Start looprail as an MCP server for Claude Code, Claude Desktop, Cursor, or VS Code |

You rarely need `workspace add` yourself - `looprail run` registers its own
project the first time you use it there.

## Features

- **Anti-gaming rails.** `protect: tests` hashes your tests and framework
  configs so "make the tests pass" can't be won by editing them; `scope:`
  allowlists what a run may touch; `no_weaker_tests: true` fails any iteration
  that drops assertions or adds skips; `verify_deps: true` catches hallucinated
  packages before they're installed. → [docs/guardrails.md](docs/guardrails.md)
- **Blind review and graded verdicts.** `blind: true` shows the critic the
  actual workspace diff, never the worker's own narrative. A passing critic
  still names its GAPS - "verified" and "verified with 2 named gaps" never
  render identically. → [docs/guardrails.md](docs/guardrails.md)
- **Evidence ledger.** `ledger: true` records every verdict into a hash-chained,
  repo-committable audit file; `looprail ledger --verify` recomputes the chain
  and names the exact break. → [docs/guardrails.md](docs/guardrails.md)
- **Self-planning loops.** A planner with `generates: graph` proposes the graph
  from a plain-English goal; a different model reviews it and a gate holds it
  for your approval. `looprail init --from-spec prd.md` does the same from a
  written spec. → [docs/self-planning.md](docs/self-planning.md)
- **Mixed-vendor loops.** Each node picks its agent, so a cheap model checks an
  expensive one and a critic panel spans providers; `probe: true` thins a
  failing panel's cost without ever thinning a pass.
  → [docs/models-and-failover.md](docs/models-and-failover.md)
- **Rate-limit failover and cost control.** `fallback:` hands work to another
  agent on 429s only - real errors stay loud; per-agent `env:` routes a CLI
  through a caching proxy; `looprail route` benchmarks variants of your own
  loopfile and records the winning mix.
  → [docs/models-and-failover.md](docs/models-and-failover.md)
- **Permissions and isolation.** Per-agent `permissions: safe | standard |
  full`; no API keys ever touch looprail; no sandbox of its own - the honest
  version is written down. → [docs/security.md](docs/security.md)
- **Fresh-context iterations.** `context: fresh` rebuilds an executor's prompt
  each iteration from goal, plan, feedback, and its on-disk notes - the Ralph
  loop pattern as a per-node switch.
  → [docs/loopfile-reference.md](docs/loopfile-reference.md#fresh-context-iterations-ralph-mode)
- **CI.** A composite GitHub Action (`action.yml`): the job passes only when
  the loop's verifiers pass, and the run journal uploads as the evidence
  trail. → [docs/ci.md](docs/ci.md)
- **Live dashboard and mission control.** `run --ui` shows the DAG live -
  streaming per-node output, cost against rails per agent, in-browser gate
  approval and resume. `looprail ui --all` is one page for every run across
  every registered project.
- **Detached runs, queue, resume.** `run -d` survives your terminal; `queue`
  batches goals overnight into a triage table (verified / parked / halted);
  `resume` continues a halted run with raised rails or an edited goal.
- **MCP server and skill.** `looprail mcp` puts lint/run/watch inside Claude
  Code, Claude Desktop, Cursor, or VS Code; `npx skills add saimeda32/looprail`
  installs the bundled skill (or copy [`skills/looprail/`](skills/looprail/SKILL.md)
  into `~/.claude/skills/` by hand) that teaches an agent *when* a verified
  loop beats a long chat. → [docs/MCP.md](docs/MCP.md)

## How it works

The engine is small and boring on purpose. Each iteration walks the graph in
dependency order and runs independent nodes at the same time. Verifying nodes
return a structured verdict with evidence. A router collects the verdicts and
decides whether the run is verified, should try again with the failures fed
back, should re-plan because it has stalled, or should halt because a rail was
hit. Config mistakes halt loudly instead of quietly burning iterations.
Transient adapter failures retry with backoff before they count against the
loop.

Every run is journaled to `~/.looprail/runs/<workspace>/<id>/journal.jsonl`
as it happens - `status`, `logs`, `resume`, `replay`, and the dashboard all
read from it, and your project directory never gets a stray `.looprail/`
folder. There is a small TypeScript SDK behind the CLI; the YAML compiles to
the same objects the SDK builds, so anything the CLI can run, the SDK can
too. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the internals.

## How looprail compares

These tools get mentioned in the same breath as looprail often enough to
compare honestly - they're not all solving the same problem.

| | **looprail** | **LangGraph** | **OpenHands** | **Cline** | **aider** |
| --- | --- | --- | --- | --- | --- |
| What it is | CLI orchestrator | Code-first graph library | Standalone coding agent | IDE extension (+ CLI) | Standalone CLI coding agent |
| Drives other agent CLIs? | Yes - that's the point | No - you build a custom agent in code | No - it is the agent | No - it is the agent | No - it is the agent |
| Verify-until-pass, built in? | Yes - a real command or a second model's review, retried until it passes or a budget runs out | No - you hand-build an evaluator-optimizer pattern yourself | No - the model self-judges "done" (`AgentFinishAction`) | No - human-approval-gated or auto-approve, no mechanical pass/fail gate | Yes, but scoped to one agent/model - `--auto-test` retries against your test command |
| Sandboxing | None of its own - inherits whatever the adapter CLI does | N/A (a library, not an execution environment) | Yes - every action runs inside a Docker container | No | No |
| Primary audience | Developers who already use an agent CLI and want a real verification loop around it | Developers building their own custom LLM application | Whoever wants an autonomous coding agent, not a CLI wrapper | Developers who want an in-editor (or terminal) pair-programmer | Developers who want one fast, scriptable terminal coding agent |

Two honest footnotes: aider is also one of looprail's own adapters, and its
`--auto-test` loop is exactly the single-agent pattern looprail generalizes
across models and panels; OpenHands' Docker sandboxing is real isolation
looprail does not have ([docs/security.md](docs/security.md)). A dated,
sourced comparison against the closest "verified done" tools (zeroshot,
agentops, loki-mode, conductor, gastown) lives in
[docs/COMPARISON.md](docs/COMPARISON.md).

## Status and limitations

The engine, CLI, adapters, Loopfile format, anti-gaming rails, self-planning,
bench/route harness, dashboard, and MCP server are here and tested. The hard
edges, stated plainly:

- Single machine, single process per run - no distributed execution.
- No sandboxing of its own ([docs/security.md](docs/security.md)) - looprail
  is only as safe as the adapter CLI and OS user running it.
- The mid-node permission relay is proven against a mock adapter only; no
  real adapter has a prompt detector wired up yet.
- A `tester`'s `expect` only supports `exit 0` - express richer assertions
  as a real command that exits nonzero on failure.
- No web UI for authoring a loopfile - `looprail init` and `examples/` are
  the two on-ramps.
- Verdict scoring is model self-report, not ground truth - which is exactly
  why cross-model panels and mechanical testers exist as the harder floor.
- If "done" can't be checked by a real command or an independent model's
  honest review, looprail can't verify it - a loop with no real verifier is
  just a slower way to prompt an agent in a circle. `looprail lint` refuses
  a loop with no tester, critic, or judge at all.

## Documentation

- [docs/loopfile-reference.md](docs/loopfile-reference.md) - roles, rails, verdict policies, templates and examples
- [docs/guardrails.md](docs/guardrails.md) - protect, scope, no-weaker-tests, dependency checks, blind review, graded verdicts, the ledger
- [docs/self-planning.md](docs/self-planning.md) - `generates: graph` and `--from-spec`
- [docs/security.md](docs/security.md) - permissions, isolation, what is and isn't sandboxed
- [docs/models-and-failover.md](docs/models-and-failover.md) - adapters, panels, failover, caching proxies, bench, route
- [docs/ci.md](docs/ci.md) - the GitHub Action
- [docs/MCP.md](docs/MCP.md) - looprail as an MCP server, host-by-host setup
- [docs/COMPARISON.md](docs/COMPARISON.md) - fact-checked comparison against the closest "verified done" tools
- [docs/BENCHMARKS.md](docs/BENCHMARKS.md) - measured results
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) - engine internals
- [examples/](examples/) - runnable loopfiles, from template mirrors to full workflows
- [benchmarks/](benchmarks/) - the committed A/B benchmarks and how to read them

## Contributing

Bug reports and pull requests are welcome. See
[CONTRIBUTING.md](CONTRIBUTING.md) for how to set up the project and run the
tests.

## License

MIT. See [LICENSE](LICENSE).
