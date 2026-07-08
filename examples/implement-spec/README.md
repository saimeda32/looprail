# implement-spec - spec-driven work with requirement coverage

Turn a written spec/PRD into a verified build with traceability enforced
twice before a single line of implementation runs:

1. The **planner** (`generates: graph`) reads the spec on disk and designs
   the node graph - and must end its plan with a **requirement-coverage
   list** mapping every spec requirement to the node that implements it and
   the node that verifies it.
2. An independent **critic on a different model** re-reads the spec itself
   and fails the plan with the exact list of uncovered or unverified
   requirements.
3. **You** approve, edit, or reject the plan at the gate. Only then does
   the approved graph splice into the run and execute.

Scaffold this shape against your own spec with:

```bash
looprail init --from-spec path/to/prd.md
```

Swap `SPEC.md` for your real document and the agents for what
`looprail doctor` shows on your machine.
