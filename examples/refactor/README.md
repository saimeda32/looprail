# refactor

Refactor a file without changing what it does, checked from two angles: did
anything actually break, and did the refactor actually help.

**What it demonstrates:** two critics reviewing the same change for
different things - `crit-correct` fails on any behavior change, API break,
or dropped edge case; `crit-quality` fails unless the refactor measurably
improves readability or reduces complexity. A refactor that's merely
different, not better, doesn't pass. The `tests` node runs your real suite
as a mechanical backstop underneath both critics.

**Run it:**

```bash
cp examples/refactor/looprail.yaml .
looprail run
```

**Adapt it:**
- The goal lets the worker pick the largest/most complex file under `src/`.
  Name a specific file instead by editing `goal:`.
- Swap `run: npm test` for your stack's real test command.
