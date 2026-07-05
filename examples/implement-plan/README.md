# implement-plan

Hand looprail a written implementation plan (a `writing-plans`-style doc with
bite-sized tasks) and have it implement every task against your existing
codebase, guarded by a full regression run.

**What it demonstrates:** working against already-shipped code, not
greenfield - both `build` and `crit` are explicitly told to read every file
the plan references and reuse existing utilities/conventions rather than
reinventing them. `tests` runs the entire existing suite (`npx vitest run`),
not just new tests for what changed, because this is editing code other
things already depend on.

**Run it:**

```bash
cp examples/implement-plan/looprail.yaml .
looprail run
```

**Adapt it:**
- Edit the `PLAN_PATH` placeholder in `goal:` to point at your own plan
  document.
- Swap `run: npx vitest run` for your stack's real full-suite command.
