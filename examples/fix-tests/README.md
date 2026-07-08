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

## The anti-gaming rails (0.8.0)

This example now ships with the full verification-integrity stack:

- `protect: tests` - any agent edit to test files (or pytest/jest/vitest
  configs) fails the iteration with a revert instruction; a repeat halts.
- `blind: true` on the critic - it reviews the actual workspace diff since
  run start, never the worker's narrative, and can grade a pass with named
  `GAPS:`.
- `ledger: true` - every verdict lands in a hash-chained, committable audit
  file; `looprail ledger --verify` proves nobody rewrote history.
