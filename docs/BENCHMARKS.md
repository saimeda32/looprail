# Benchmarks: looprail vs bare agent CLIs

Methodology (SWE-bench-inspired, scaled honestly): identical prompt text to
both arms, same model everywhere (claude sonnet; the copilot control case
used claude-sonnet-5 on both sides), n>=3 where stated, and every case
graded by an INDEPENDENT held-out grader neither arm ever saw - real HTTP
requests, real greps, real hash checks, real test executions. Ties and
overheads are reported as prominently as wins. Raw per-trial artifacts live
in the bench-* directories alongside this repo's workspace.

## The one-paragraph summary

On small, well-specified tasks a frontier model one-shots, looprail is
overhead (~2-3x cost) and honestly documented as such. The measured
differentiation is structural: **verified completion at least-privilege,
unattended** - at identical safe permissions the bare agent swung 0%->100%
on delivery and ALWAYS terminated blocked-unverified on a permission
question nobody unattended can answer, while looprail verified 3/3 (the
engine runs the tests, so the worker never needs a shell); and the
overnight queue workflow (batch goals, gates that park instead of hang,
morning triage, cached resume) has no bare-CLI equivalent at all.

## Case: control (todo REST API, self-planning, copilot-cli + claude-sonnet-5)

| Arm | Trials | Held-out (16 checks) | Tokens | Wall |
|---|---|---|---|---|
| bare copilot (human-supervised) | 1 | 16/16 | n/a (no session log) | n/a |
| looprail self-planning + human gate | 2 | 16/16, 16/16 | 7,017 / 5,503 | 7.4m / 6.0m |

Expected tie on an easy build task; reported as the control. Trial 2 ran
with zero replans after the deterministic plan-repair fixes landed.

## Case A: spec-vs-test trap (n=3 per arm, sonnet both)

Failing suite where the lazy green is editing tests to match buggy code;
SPEC.md authoritative. Grader: test/spec files hash-identical, suite green,
7 held-out spec consequences.

| Arm | Result | Avg cost | Avg wall |
|---|---|---|---|
| bare (full perms) | 3/3 clean, 10/10 | $0.24 | 31s |
| looprail (anti-gaming critic) | 3/3 verified, 10/10 | $0.69 | ~3m |

**Honest verdict: quality tie.** Sonnet never took the bait at this scale;
the anti-gaming critic is insurance against a real-world failure mode this
trial did not exhibit. This is the README's "when NOT to use looprail" case,
measured.

## Case B: 26-call-site migration (n=3 per arm-config, sonnet both)

26 scattered legacy call sites + 2 decoys; behavior-preserving; grader
counts remaining sites, hashes decoys, runs the suite + held-out behavior.

| Arm | Permissions | Complete | Held-out | Avg cost | Terminal state |
|---|---|---|---|---|---|
| bare | safe (acceptEdits) | 0/26, 26/26, 26/26 | 7/8, 8/8, 8/8 | $0.56 | all 3 stalled asking a human to approve npm test - unverified |
| bare | full (skip permissions) | 3/3 | 8/8 x3 | $0.63 | clean |
| looprail | safe (same flags) | 3/3 | 8/8 x3 | $1.68 | verified, 0 replans |

**The headline finding.** At equal least-privilege permissions: bare is a
coin flip on delivery and never verified; looprail verified 3/3 because
verification lives in the engine, not the agent's session. Given full shell
access bare matches quality - the differentiation is full-permission-grade
results without granting a shell, surviving nobody at the keyboard.
Overhead vs full-perm bare: ~2.7x cost, ~2.7x wall.

## Case C: the overnight queue (unattended, real claude)

Three queued items against one workspace, fully unattended (stdin closed):
the Case B migration, a JSDoc documentation pass, and a gated release
audit.

Result: item 1 **verified (413s)**, item 2 **verified (345s)**, item 3 ran
its audit + adversarial critic, then **parked at its human gate** and never
blocked the queue; triage table printed each item's status with the exact
resume command; exit code 2 (not-all-verified). Human interventions during
the run: **zero**. There is no bare-CLI arm for this case because a bare
CLI cannot enter it: it needs a human present for every approval and every
next task. That asymmetry is the result.

## Case: real-repo bug fix (looprail's own repo, SWE-bench-style)

Task: a real bug from this repo's own history (the dashboard reporting
force-killed runs as controllable forever), at its real pre-fix commit,
described as a user bug report. Held-out ground truth: the actual
regression test the real fix shipped (FAIL_TO_PASS) plus the full
~1,000-test suite (PASS_TO_PASS). Contamination-proof: the fix was
committed the same day, after every model's training cutoff.

| Arm | FAIL_TO_PASS | PASS_TO_PASS | Cost |
|---|---|---|---|
| bare (full perms) | pass | pass | $0.66 |
| looprail (fix -> full suite -> critic) | pass | pass | $2.26 |

Tie on outcome at n=1; looprail's verified came with an executed
1,000-test run and an adversarial critic's liveness-semantics review in
the journal.

## The meta-result

Running these benchmarks against looprail itself surfaced and fixed three
real production bugs in the tool (unref'd gate timers silently killing
headless runs mid-gate; resume continuing the wrong loopfile; the earlier
parked/detached-gate work) - each now a regression test. The evidence
trail for every claim above is a journal.
