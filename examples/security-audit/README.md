# security-audit

Audit a repository with one auditor and three adversarial critics - each
attacking the report through a different lens (injection, secrets,
dependencies) on deliberately different models - then an independent judge
scores the surviving report before a human triages the findings.

**What it demonstrates:** multi-lens verification, which is not the same
thing as a `panel:`. Panel members share one prompt; these three critics
each get their OWN adversarial prompt and run concurrently (`after: audit`
on all three, no dependency between them). Different failure modes need
different attackers: a lens that hunts missed injection surfaces will never
notice a leaked credential path. The judge runs only `after:` all three
lenses, so it scores a report that already survived adversarial coverage
review - and the final `gate` keeps severity triage where it belongs, with
a human.

**Run it:**

```bash
cp examples/security-audit/looprail.yaml .
looprail run --ui        # watch the three lenses attack concurrently
```

**Adapt it:** the audit categories live in one place - the `goal:` - and
each lens's prompt names its own hunting ground. Add a lens (auth flows,
CORS/headers, crypto misuse) by adding one agent and one critic node;
drop one the same way. Raise `score`'s `threshold` for a stricter bar, and
keep the `triage` gate: an audit that auto-approves its own findings is
exactly the anti-pattern this loop exists to prevent.

This is an audit *report* flow - it changes no code. Chain a second loop
(e.g. `fix-tests`-shaped, one finding per `looprail queue` item) to actually
fix what the human approves.

## Provenance

`ledger: true` records every lens's verdict into a hash-chained,
repo-committable ledger - an audit that can prove its own provenance.
`looprail ledger --verify` recomputes the chain.
