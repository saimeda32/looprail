# Architecture

This is a short tour of how looprail is put together, for anyone who wants to
work on it or understand what happens when a loop runs.

## The shape of a loop

A loop is a directed graph of nodes. Each node has a role (planner, executor,
tester, critic, judge, gate, or synthesizer). The graph describes one pass:
what feeds into what. The looping itself is not in the graph. It lives in the
router, which decides after each pass whether to go again.

Keeping the graph free of cycles means one pass always terminates, and the
number of passes is something the rails control rather than something an edge
in the graph can run away with.

## One iteration

The scheduler (`src/engine/scheduler.ts`) walks the nodes in dependency order.
Nodes that do not depend on each other run at the same time, up to a
concurrency cap. That is what lets a critic panel of three models run together
instead of one after another.

Each node runs through `src/engine/nodes.ts`. Agent-backed roles build a prompt
from the goal, the plan, the last round of feedback, and whatever upstream
output they are reviewing, then call an adapter. Testers run a shell command.
Gates ask a human. Every node returns an outcome, and verifying nodes attach a
structured verdict with evidence. A node never throws out of here: a crash
becomes an error verdict so one bad node can't take down the run.

## Verdicts and the router

The router (`src/core/router.ts`) collects the verdicts from an iteration and
combines them under the loop's policy (all-pass, quorum, or weighted). Then it
decides:

- All checks passed: the run is verified and finishes.
- A check failed: compose the real failures into feedback and iterate.
- The same failures keep repeating: re-plan, or halt if re-plans are used up.
- A rail was breached, or a config or auth error showed up: halt.

Config mistakes (a critic pointed at work that was never produced, an
unregistered agent) are tagged so they halt loudly and immediately. A genuinely
transient adapter failure is retried with backoff first, and only iterates if
it survives the retries. The two are kept apart on purpose, so a typo in a
Loopfile fails fast while a flaky network call gets a second chance.

## Rails

The rails guard (`src/core/rails.ts`) tracks iterations, spend, and wall-clock
time. The runner checks it before starting a node, not after, so a loop halts
the moment the next step would go over budget. If a rail trips partway through
an iteration and skips a verifier, the run refuses to report "verified" and
halts instead, because a check that never ran cannot pass.

## The journal

Every run writes a line-delimited JSON journal to
`.looprail/runs/<id>/journal.jsonl` as it goes. This is the single source of
truth for everything after the fact: `status` and `logs` read it, and `resume`
and `replay` rebuild a cache from it. The cache is keyed on a hash of each
node's exact prompt, so if you edit one prompt and replay, only that node and
the nodes downstream of it run again. Everything else comes back from cache for
free.

## Adapters

An adapter is anything that takes a prompt and returns output plus cost and
token counts (`src/adapters`). The CLI adapters shell out to `claude`, `codex`,
`aider`, or `gh copilot` and parse whatever cost data they expose. The shell
adapter runs an arbitrary command template and is the escape hatch for anything
else, including local models. Because every adapter looks the same to the
engine, a loop can mix providers node by node, and the run report can break
cost down per agent.

## Loopfile and SDK

A `looprail.yaml` is parsed (`src/config/loopfile.ts`) into the same objects
the TypeScript SDK builds directly, so there is one engine behind both. The
linter (`src/config/lint.ts`) runs a handful of checks against that object: a
loop with no way to verify itself, missing budgets, a judge grading its own
model, a panel with nothing to aggregate it, and so on. The `init` templates
are all required to lint clean.
