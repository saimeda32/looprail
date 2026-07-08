# judge-panel

Get three genuinely different models to each propose their own approach to
a real decision, score all three against the same rubric with an
independent two-judge panel, then synthesize a final recommendation that
grafts the best ideas from the runners-up onto the winner.

**What it demonstrates:** `panel:` fan-out - `propose` lists three named
agents (`approach-a/b/c`), each running concurrently with no dependency
between them, not the same model asked three times. `score` is a second
panel of two judges scoring independently, so no single judge's own bias
(e.g. favoring verbosity) silently decides the outcome. Note `after:
[propose]` on `score`, not `of:` - a judge reviewing a panel needs `after`
to see every member's output side by side.

**Run it:**

```bash
cp examples/judge-panel/looprail.yaml .
looprail run
```

**Adapt it:** replace the `goal:` placeholder with your real decision (a
caching strategy, a data model, an architecture choice) - the more concrete
the decision, the more useful the panel's spread of proposals will be.

## Probe mode

The judge panel runs with `probe: true`: judge-a reads first, and if it
already fails the round, judge-b is skipped - the aggregate is decided, so
the second read would be pure spend. A passing round still requires both
judges (the pass path is never thinned).
