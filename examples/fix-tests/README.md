# fix-tests

Point a worker at a failing test suite and don't stop until it's green -
with a critic watching for the cheap way out.

**What it demonstrates:** a tight executor → tester → critic shape. The
`tests` node actually runs `npm test` and checks its exit code (a real
mechanical check, not a model's opinion of whether it passed). The `crit`
node exists because a model left alone with a failing test will sometimes
"fix" it by deleting or skipping it - the critic's only job is to fail the
loop if that happened.

**Run it:**

```bash
cp examples/fix-tests/looprail.yaml .
looprail run
```

**Adapt it:**
- Swap `run: npm test` for your stack's real command (`pytest`, `go test
  ./...`, `cargo test`, ...).
- The goal text is generic on purpose - point it at a specific file or
  package by editing the `goal:` field if you don't want the whole suite in
  scope.
