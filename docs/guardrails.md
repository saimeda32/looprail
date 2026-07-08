# Guardrails: the anti-gaming rails

A loop is only as honest as the check that ends it - and agents game checks.
Every rail on this page is deterministic engine behavior, not a prompt rule:
the agent can't rationalize past it because it never sees a choice.

## Protected files: the test-tamper guard

The best-documented way agents game a verified loop is editing the tests
instead of the code - deleting assertions, adding skip markers, patching
`conftest.py` so "tests passed" stops meaning anything. Telling the agent
not to (in a prompt, a CLAUDE.md, an AGENTS.md) demonstrably does not hold.
`protect:` makes the rule structural:

```yaml
protect: tests   # or an explicit list: ["test/**", "golden/*.json"]
```

At run start, looprail hashes every file matching the globs (`tests`
expands to the common test layouts plus the framework configs -
`conftest.py`, `jest.config.*`, `vitest.config.*` - whose patching is a
documented exploit). After each iteration it re-checks:

- **First violation** - the iteration fails with a deterministic verdict
  naming every modified/deleted/added protected file and an explicit
  instruction to revert and change the implementation instead. The loop
  self-corrects: agents that revert go on to verify normally.
- **Second consecutive violation** - the run halts. An agent that rewrites
  the tests again after an explicit revert instruction is not going to
  stop, and the budget is better kept.

Every violation is journaled as a `protect_violation` event, so the
evidence trail shows exactly what was touched and when. No git required -
the guard is snapshot-based and works in any directory. The `fix-tests`
and `refactor` templates ship with `protect: tests` on by default.

## Scope: the allowlist

The same machinery also runs in reverse. `scope:` is an allowlist - the
answer to silent scope creep ("asked for a modal fix, got 12 files
including unrelated CSS"):

```yaml
scope: ["src/billing/**", "docs/billing.md"]   # the run may touch ONLY these
```

Any change outside the scope globs fails the iteration with a revert
instruction (journaled as `scope_violation`), and a second consecutive
violation halts the run. `protect:` and `scope:` compose: protect pins
files that must not change at all, scope bounds where everything else may
happen.

## No-weaker-tests rail

`protect: tests` is for suites that already exist. When the agent *writes
its own tests* (build-app loops), the gaming move is different: delete the
assertion that fails, or add `.skip` to the hard case. `no_weaker_tests:
true` lets the suite grow and move freely but fails any iteration where it
gets weaker - net assertion count dropped, or skip markers added -
naming the suspect files with a restore instruction. The floor ratchets:
every improvement becomes the new minimum. Deterministic (pattern counts,
no model), aggregate-based so refactors that move tests between files
never trip it.

## Hallucinated-dependency rail

Roughly a fifth of agent-suggested package names don't exist - and
attackers squat the recurring fake names (slopsquatting). `verify_deps:
true` checks every package an iteration ADDS to `package.json` or
`requirements.txt` against its public registry:

- **Doesn't exist** → the iteration fails, naming each hallucinated
  package, with a warning that a similarly-named existing package may be a
  squatted lookalike.
- **Exists but published < 90 days ago** → journaled as a squat signal
  (`deps_check` event), never a fail on its own - new legitimate libraries
  exist.
- **Registry unreachable** → said out loud as unchecked, never silently
  treated as verified.

Only newly added names are probed; the run-start manifest is the baseline.

## Blind validation

By default a critic reviews the target node's *output* - which for a coding
executor is its own narrative about what it did. A lying or hallucinating
worker fools that critic. `blind: true` swaps the review target for the
**actual workspace diff since run start**:

```yaml
crit: { role: critic, agent: reviewer, of: build, after: tests, blind: true }
```

The critic never sees the worker's story - only what really changed on
disk (including commits the agent made mid-run, and new untracked files).
Needs a git workspace; without one the critic is told explicitly that no
diff is available and to treat claims as unverified - blind mode never
silently falls back to the narrative. Lint rule L013 warns when `blind`
is set somewhere it has no effect.

## Graded verdicts

A critic that passes work while seeing real minor shortcomings names them:

```
VERDICT: pass
EVIDENCE: core flow works end to end
GAPS: no retry on 503; error copy is vague
```

The pass still passes - but the run reports `verified WITH 2 named
gap(s)`, lists each one, and `--json` carries them structurally. "Verified"
and "verified, with these shortcomings" never render identically, so a
polite critic can't wave work through silently.

## Evidence ledger

`ledger: true` in a loopfile records every verdict the run produces into a
hash-chained, repo-committable audit file (`.looprail/ledger.jsonl` by
default; a string value picks a custom path): who judged what, on which
model, with what evidence, and a sha256 of the exact output that was
judged. Each entry's hash covers the previous entry's hash, so editing or
deleting history breaks every hash after it - `looprail ledger --verify`
recomputes the chain and names the exact break. Commit the file and the
repo carries its own provenance trail: "this change was verified by
<model> on <date>", checkable by anyone with the repo.
