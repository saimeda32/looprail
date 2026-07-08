# staged-migration

Migrate a codebase in verified stages: inventory every call site first,
plan against that inventory, get the plan critic-reviewed and
human-approved BEFORE any code changes, then execute and verify twice -
tests for behavior, a completeness critic for the failure tests can't see.

**What it demonstrates:** a mid-graph human checkpoint at the cheapest
possible moment. The `approve` gate sits after `plan-crit` and before
`migrate`: rejecting there costs a replan, not a rewrite, and your
rejection feedback drives the next plan. It also shows why migrations need
TWO verifiers - `npm test` passing proves behavior, but a half-migrated
codebase (old and new styles coexisting) is usually still green; only
`crit-done`, re-checking the migrated code against the original inventory
item by item, catches "the agent quietly stopped at 60%".

**Run it:**

```bash
cp examples/staged-migration/looprail.yaml .
# 1. edit the goal's <OLD>/<NEW> line to your real migration
# 2. point `run: npm test` at your stack's real test command
looprail run --ui        # approve or reject the plan from the dashboard
```

For a large migration, run it detached and answer the plan gate whenever
you're ready - the run parks (resumable, nothing repeated) if you're away
past `gate_timeout`:

```bash
looprail run -d
looprail ui --all        # mission control: the gate shows up here
```

**Adapt it:** the inventory prompt is the lever - scope it ("under src/",
"only the payments module") to control blast radius. Tighten `crit-done`
with migration-specific checks (e.g. "fail if any import of <OLD> remains
anywhere"). For riskier migrations, add a second gate after `crit-done` so
a human also signs off on the final diff before you merge it.

## Scope rail

`scope:` allowlists the migration's own surface - an iteration that touches
anything outside it fails with a revert instruction, and a repeat halts.
Edit the globs to your migration's real area before running.
