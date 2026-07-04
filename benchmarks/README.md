# looprail benchmarks

Three A/B benchmarks that back the claim in the project README: an
engineered loop (a plan reviewed up front, a critic panel that never grades
its own work) beats the naive pattern (one executor, one critic, same model,
one retry) on pass rate and wasted-work cost.

## Fixtures

- `bug-fix-on-seeded-repo.bench.yaml` — fix the one failing test in a seeded repo.
- `cited-research-report.bench.yaml` — produce a report where every claim is cited.
- `data-pipeline-fix.bench.yaml` — repair a broken pipeline transform.

Each one points at a `baseline.yaml` and a `looprail.yaml` in its own
subdirectory. Every agent in every fixture uses `adapter: mock`, so the
fixtures run for free and offline, and they are what `npm test` actually
executes (see `src/bench/benchmarks.test.ts`) to prove the bench harness
end to end on every commit.

Every `looprail.yaml` closes its critic panel with a `merge` synthesizer
node (`role: synthesizer`, `after: crit`) — this is not optional decoration:
`looprail lint` (rule L004) flags any `panel:` fan-out that has no
downstream judge or synthesizer to aggregate its findings, the same pattern
the `research-report` template already uses.

## Running them as committed

```bash
looprail bench benchmarks/bug-fix-on-seeded-repo.bench.yaml
```

Run this way, `looprail bench` uses its default registry, whose `mock`
adapter auto-passes every verdict (the same adapter `looprail init`
scaffolds for a first, zero-setup run). Both arms will show a 100% pass
rate — that is expected, not a benchmark result. The number worth trusting
comes from either of the two paths below.

## Running the real-adapter variant

Copy a fixture's `baseline.yaml` and `looprail.yaml`, and change every
`adapter: mock` line to a real one you have installed and logged into
(`looprail doctor` shows what is available), for example:

```yaml
agents:
  worker:  { adapter: claude-code, model: sonnet }
  checker: { adapter: claude-code, model: haiku }
  skeptic: { adapter: codex }
```

Then point a benchfile at your copies and run it:

```bash
looprail bench my-bug-fix-on-seeded-repo.bench.yaml --json > result.json
```

This spends real API cost, at whatever rate your adapters bill. The report
labels every config's numbers `mode: "real"` once at least one agent in that
config is not the mock adapter, and the printed table's scripted-cost
banner disappears once every config in the report is real. Nothing in this
harness ever reports a mock number as if it were a real one, or the reverse.

## Interpreting the report

- **pass rate** — fraction of the `repeat` runs that ended `verified`.
- **mean iters / iters->verified** — average passes through the loop,
  over all runs and over the verified subset respectively.
- **wasted $ / wasted %** — executor spend that did not belong to the
  iteration that actually landed (see `src/bench/metrics.ts` for the exact
  formula); a halted run counts as 100% wasted executor spend once execution
  has begun, since nothing landed. A run that halts before any executor node
  runs (e.g. an aggressive `max_cost_usd` breached during planning)
  contributes zero to this metric, since no executor spend means no executor
  waste.
- **the one-line verdict** — compares every config against `baseline` (or
  the first config, if none is named `baseline`) on pass rate, breaking
  ties on mean iterations to verified.
