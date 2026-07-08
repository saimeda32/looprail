# Loopfile reference

A loop lives in a `looprail.yaml`. This page covers the file's shape:
roles, rails, verdict policies, and where to start from. The anti-gaming
fields - `protect:`, `scope:`, `no_weaker_tests:`, `verify_deps:`,
`blind:`, `ledger:` - are documented in [guardrails.md](guardrails.md);
mixed-vendor agent maps, `panel:`, `probe:`, `fallback:`, and per-agent
`env:` in [models-and-failover.md](models-and-failover.md); `generates:
graph` in [self-planning.md](self-planning.md); and `permissions:` in
[security.md](security.md).

## Writing a Loopfile

Here is a small one that fixes failing tests:

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

## Starting points: templates and examples

`init` picks a template for you (`fix-tests`, `research-report`, `refactor`,
`content-pipeline`, `review-diff`, or `build-app`) and fills in whichever
agent CLIs it found. For each role in the template it asks which tier to run
on, strong, medium, or cheap, with a sensible default already highlighted, so
you decide the cost/quality tradeoff per role instead of guessing at YAML by
hand. Pass `--yes` to accept every recommended default with zero prompts, or
`--template <name> --agent <adapter>` to skip detection entirely.

Prefer to start from a real file instead of a wizard? Every template also
exists as a standalone example under [`examples/`](../examples/) - each one
has its own README explaining what it demonstrates and what to change,
ready to `cp` into your project. Beyond the template mirrors, the gallery
includes full workflows: an [overnight queue](../examples/overnight-queue)
(batch goals unattended, triage in the morning), a
[security audit](../examples/security-audit) (three adversarial critic lenses
on different models + an independent judge), a
[staged migration](../examples/staged-migration) (inventory -> plan ->
human-approved before any code changes -> migrate -> double verification),
a [judge panel](../examples/judge-panel) (three models compete, two judges
score, probe mode skips the second judge on already-failed rounds),
[implement-spec](../examples/implement-spec) (a written PRD becomes a
human-approved plan with requirement-coverage review before anything
executes), and [multi-gate approval](../examples/multi-gate-approval). The
[fix-tests example](../examples/fix-tests) ships the full anti-gaming stack:
`protect: tests`, a blind critic reviewing the actual diff, and a
hash-chained evidence ledger.

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

## Fresh-context iterations (Ralph mode)

On long runs, dragging a growing previous-attempt transcript through every
prompt is how sessions rot: agents contradict earlier decisions and forget
conventions. `context: fresh` on an executor rebuilds its prompt each
iteration from the durable anchors only - goal, plan, current feedback,
and the agent's own on-disk notes:

```yaml
build: { role: executor, agent: worker, context: fresh }
```

The agent is instructed to inspect the workspace for current state and to
maintain `.looprail/progress.md` (what's done, what remains, what the next
iteration must know) - the disk is the memory, the transcript is not.
This is the "Ralph loop" pattern the community converged on for
long-horizon agent work, as a per-node switch.

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
moment it would go over budget rather than one expensive step later. A
misconfigured loop (a critic pointed at work that doesn't exist, an
unregistered agent) halts loudly and immediately instead of quietly burning
iterations trying to recover from something that will never fix itself.

## Verdict policies

How the checks combine into a pass or fail:

- `all-pass` (default): every check must pass.
- `{ quorum: N }`: at least N checks must pass.
- `{ weighted: 0.7 }`: the pass weight over the total weight must clear the
  threshold. Give a node more weight with `weight: 2`.
