# build-app

Build something from a plain-English spec, greenfield - the worker writes
both the app and its own tests, since there's no pre-existing suite to run.

**What it demonstrates:** a `plan → build → tests → crit` pipeline for
greenfield work, where the critic's job is specifically to catch the failure
mode `tests` alone can't: an agent writing weak tests for weak work. `crit`
checks whether the result actually satisfies the spec, independent of
whether its own self-authored tests happen to pass.

**Run it:**

```bash
cp examples/build-app/looprail.yaml .
looprail run
```

**Adapt it:**
- Edit the `goal:` field's `SPEC` placeholder with what you actually want
  built, including your language/framework if you have one - the more
  concrete, the better the critic can judge against it.
- Swap `run: npm test` for your stack's real test command.
