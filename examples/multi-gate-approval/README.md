# multi-gate-approval

Two separate human checkpoints, not one: approve the proposed approach
before any code gets written, then approve the actual result before the
loop is considered done.

**What it demonstrates:** `gate` nodes aren't limited to one per loop, and
don't have to sit only at the very end. `approve-design` gates everything
downstream of `plan` - reject it and nothing has been implemented yet, so
a bad direction costs nothing to redirect. `approve-release` is a second,
independent sign-off after `tests`/`crit` review the actual implementation
- approving the plan doesn't pre-approve what got built from it.

**Run it:**

```bash
cp examples/multi-gate-approval/looprail.yaml .
looprail run --ui
```

You'll be asked to approve twice: once after `plan`, once after
`crit`/`tests`. Reject either with feedback to send it back for another
attempt instead of just a flat no.

**Adapt it:**
- Edit the `CHANGE` placeholder in `goal:` with what you actually want built.
- Swap `run: npm test` for your stack's real test command.
- Add more gates the same way if your own process has more than two real
  sign-off points - each is just another `role: gate` node wired with
  `after:`.
