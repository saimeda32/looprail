# Efficiency A/B (EFF-7): the optimization work, in real dollars

Everything else in `benchmarks/` A/Bs two *loop configs* on mock adapters,
free and offline. This one is different: it A/Bs two *engine versions* on
real agents to price the efficiency work that landed in 0.6.0 -
lineage-scoped feedback, the within-run cache, and incremental executors.

## What it measures

The loopfile has two independent branches: a fix branch engineered to
iterate (a naive `slugify()` against a strict edge-case suite - diacritic
folding, camelCase splitting, apostrophe deletion) and a docs branch that
usually passes first try.

- **looprail@0.5.0** prepended global feedback to every node's prompt, so
  one branch failing re-ran (and re-billed) *everything*, docs branch
  included, every iteration.
- **The current engine** scopes feedback to the failing node's own lineage
  and serves byte-identical prompts from the within-run cache, so
  iteration 2+ re-runs only the branch that actually failed.

Same task, same rails, same models - the cost and invocation delta is the
optimization.

## Run it

```bash
npm run build          # from the repo root, so "new" is this checkout
benchmarks/efficiency/run.sh
```

It asks for confirmation first: **this spends real money** through your
installed agent CLIs, bounded by the loopfile's `max_cost_usd: 6` per
engine (≤ ~$12 worst case, typically much less). Edit
`looprail.yaml`'s `agents:` block first if `looprail doctor` doesn't show
`claude-code` on your machine; keep worker and reviewer on different models.

## Reading the result

The script prints one row per engine: `status / iterations / costUsd /
billed-agent-invocations`. Billed invocations are counted from each run's
own journal as `node_end` events with nonzero cost (real `costUsd`, or
`estimatedCostUsd` for CLIs that never report dollars) - a cache-served
node journals with both zeroed, so what's counted is exactly the calls
that spent money.

- **The run iterated** → expect the new engine to show fewer invocations
  and lower cost for the same verified outcome. That gap is the measured
  value of the efficiency work.
- **The worker nailed it first try** → both engines cost about the same.
  That is an honest result, not a failure of the harness: the optimization
  only pays on iterating runs. Re-run it; the seeded edge cases miss often
  enough.

Caveats worth stating: model outputs vary run to run, so treat a single
pass as an anecdote and 3-5 passes as a result; and both engines pay npx
download time on first use, which affects wall-clock but never cost.
