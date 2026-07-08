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
looprail run --dry-run    # preview node order, per-node models, and budget - spends nothing
looprail run --ui         # run with a live dashboard (gates answerable there)
```

`looprail templates` lists the built-in loop shapes with what each verifies;
`looprail init --yes` scaffolds non-interactively. `looprail lint` checks a
loopfile without running it. `looprail doctor` shows which agent CLIs are
installed and logged in. To show the user what looprail even is,
`looprail demo` runs a full verified loop offline in seconds - no API key,
no agent CLI, nothing touched.

## The commands that matter

| Task | Command |
| --- | --- |
| Preview what a run will do before spending | `looprail run --dry-run` (node order, models, budget; exits without invoking any agent) |
| Run until verified, watch live | `looprail run --ui` |
| Run in background, survives the terminal | `looprail run -d` (watch/answer gates via `looprail ui --all`) |
| Batch many goals unattended | `looprail queue` (queue.yaml of goals; gated items park, never block) |
| Continue a parked/halted run | `looprail resume <runId>` (prior work cached, never re-billed) |
| See every run across projects | `looprail ui --all` (mission control, port 4748) |
| Machine-readable result | `looprail run --json` (status/cost/journal path; exit 0 verified, 2 halted, 1 error) |

## Choosing adapters and models per role

Don't guess - `looprail doctor` lists which agent CLIs are actually
installed and logged in; only wire those. `looprail init` encodes the
recommended tiers per template role, so scaffolding from it (or `--yes`)
is already a sound default.

Which PROVIDER to spend is the user's call, not yours: multiple installed
CLIs means multiple subscriptions/quotas, and you cannot know which one
the user prefers to burn. If the repo already has a looprail.yaml, its
agents block IS the user's standing answer - reuse it. If not, and doctor
shows more than one adapter, ask the user once ("claude-code and
copilot-cli are both available - which should be the worker? I'll use the
other as the independent reviewer") before scaffolding. Only when exactly
one adapter is available is there nothing to ask.

When authoring by hand, pick by role, not by habit:

| Role | Tier | Why |
| --- | --- | --- |
| planner, judge | strong (e.g. opus) | plan quality and scoring judgment bound the whole loop's quality |
| executor | medium (e.g. sonnet) | the loop's iteration + verifiers compensate for a mid-tier worker; pay for strong only on genuinely hard builds |
| critic | cheap-to-medium (e.g. haiku) | adversarial checking against concrete evidence is cheaper than generation - but use medium+ when the check needs real domain understanding (hallucinated claims, security) |
| tester | none | it runs a command; no model involved |

Two hard rules the tooling itself enforces or expects:

- Critic/judge on a DIFFERENT model (ideally different provider/adapter)
  than the worker they grade - `looprail lint` warns when a judge shares
  the executor's model. Same model grading itself shares its blind spots.
- Model-string conventions differ per adapter: `claude-code` takes a tier
  name (`opus`/`sonnet`/`haiku`) or a full dashed id; `copilot-cli` needs
  its own catalog names with DOTS (`claude-sonnet-5`, `claude-opus-4.8`,
  `gpt-5.3-codex`); `codex`/`aider` default sensibly when `model:` is
  omitted. When unsure, omit `model:` and let the adapter's default stand.

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
- Add `protect: tests` whenever existing tests define "done" (fix-tests,
  refactor shapes): any agent edit to test files then fails the iteration
  with a revert instruction, and a repeat halts the run - the structural
  answer to test-gaming, far stronger than prompt rules.
- Add `scope: ["src/feature/**"]` when the task should stay inside a known
  area: changes outside the allowlist fail the iteration the same way -
  the structural answer to silent scope creep.
- `panel: 3` (or `panel: [a, b, c]`) fans a critic/judge out for diverse
  review. Add `probe: true` to cut panel cost on failing iterations: the
  first clone runs first, and if it FAILS the rest are skipped - the
  iteration is already decided (all-pass policy only; a verified pass
  still requires every clone to run and pass). Put the cheapest reviewer
  first in the list.

## Self-planning (when no loopfile fits)

A planner node with `generates: graph` designs the node graph itself from
the plain-English goal; a critic reviews it and a gate lets the human
approve/edit/reject the plan before anything executes. See
`examples/self-planning`.

## MCP alternative

`looprail mcp` exposes the same engine as MCP tools (run_loop, run_status,
lint_loopfile, explain_node) for hosts that prefer tools over a terminal -
setup per host in the repo's docs/MCP.md.
