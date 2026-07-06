---
name: looprail
description: Use when a coding task needs verified completion (real tests + independent review, not self-reported "done"), unattended/overnight execution, a human approval checkpoint, or cross-model verification - looprail runs coding agents in a loop until verifiers pass. Trigger on asks like "run this until it's actually done", "batch these tasks overnight", "I want to approve the plan before it changes code", "have another model review this".
---

# Running verified agent loops with looprail

looprail is a CLI orchestrator that wraps coding agents (claude-code, codex,
copilot-cli, aider) in a verification loop: executor -> real test run ->
independent critic (a DIFFERENT model) -> optional human gate, iterating
until verifiers pass or a budget rail stops it. It is not an agent itself -
it runs the agent CLIs already installed, and exits 0 only when the work is
verified done, never merely when a model stops talking.

## When to reach for it (and when not)

Reach for looprail when the task has real first-attempt-failure risk or
gameable self-verification: multi-step builds, migrations, refactors,
"make the tests pass", anything the user wants to run unattended, and
anything where the user wants an approval checkpoint or a second model's
independent review. Do NOT reach for it for quick one-shot edits a single
agent reliably nails - the loop is overhead there, and looprail's own docs
say so.

## Quickstart in a repo

```bash
npm install -g looprail   # once
looprail init             # detects installed agent CLIs + the repo's test command,
                          # scaffolds looprail.yaml from a template gallery
looprail run --ui         # run with a live dashboard (gates answerable there)
```

`looprail init --yes` scaffolds non-interactively. `looprail lint` checks a
loopfile without running it. `looprail doctor` shows which agent CLIs are
installed and logged in.

## The commands that matter

| Task | Command |
| --- | --- |
| Run until verified, watch live | `looprail run --ui` |
| Run in background, survives the terminal | `looprail run -d` (watch/answer gates via `looprail ui --all`) |
| Batch many goals unattended | `looprail queue` (queue.yaml of goals; gated items park, never block) |
| Continue a parked/halted run | `looprail resume <runId>` (prior work cached, never re-billed) |
| See every run across projects | `looprail ui --all` (mission control, port 4748) |
| Machine-readable result | `looprail run --json` (status/cost/journal path; exit 0 verified, 2 halted, 1 error) |

## Writing a loopfile for the user

Start from `looprail init`'s templates or the repo's `examples/` gallery
(overnight-queue, security-audit, staged-migration, judge-panel) rather
than authoring YAML from scratch. Principles that make loops actually
verify:

- The tester must RUN something real (`run: npm test, expect: exit 0`) -
  never trust an agent's self-report that tests pass.
- The critic should be a DIFFERENT model/adapter than the worker
  (cross-model verification), prompted adversarially ("fail if any test
  was deleted, skipped, or weakened").
- Put a `role: gate` node wherever the user should approve - a plan gate
  BEFORE code changes is the cheapest place to say no. Gates time out into
  a PARKED, resumable state, never a failure.
- Always set rails: `max_iterations`, `max_cost_usd`, `max_wall_minutes`.

## Self-planning (when no loopfile fits)

A planner node with `generates: graph` designs the node graph itself from
the plain-English goal; a critic reviews it and a gate lets the human
approve/edit/reject the plan before anything executes. See
`examples/self-planning`.

## MCP alternative

`looprail mcp` exposes the same engine as MCP tools (run_loop, run_status,
lint_loopfile, explain_node) for hosts that prefer tools over a terminal -
setup per host in the repo's docs/MCP.md.
