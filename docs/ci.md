# Using looprail in CI

The repo ships a composite GitHub Action ([`action.yml`](../action.yml) at
the repo root): the job passes only when the
loop's verifiers pass - a real test run and independent critics, not the
model's own claim of being done. The run journal is the evidence trail;
upload it as an artifact.

```yaml
name: verified-agent-work
on: workflow_dispatch

jobs:
  loop:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm install -g @anthropic-ai/claude-code   # whichever agent CLI your loopfile uses
      - uses: saimeda32/looprail@main
        id: loop
        with:
          loopfile: looprail.yaml     # gates auto-approve in CI (no human at the keyboard)
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
      - uses: actions/upload-artifact@v4
        if: always()                  # the journal matters MOST when the run failed
        with:
          name: looprail-journal
          path: ${{ steps.loop.outputs.journal }}
```

Outputs: `status` (verified/halted/error), `run-id`, `cost-usd`, and
`journal` (absolute path to the run's journal.jsonl). Exit semantics match
the CLI: the step fails unless the run verified.
