# research-report

Turn a plain-English research question into a cited report, with a planning
critique up front and a two-critic panel checking the draft for unsupported
claims before a synthesizer produces the final version.

**What it demonstrates:** a longer pipeline - `plan → plan-crit → draft →
crit (panel of 2) → merge` - and weight-free `all-pass` verdict where every
critic must clear before the loop finishes. `plan-crit` runs for 2 rounds
(`rounds: 2`) so the plan itself gets scrutinized before any drafting starts,
not just the finished draft.

**Run it:**

```bash
cp examples/research-report/looprail.yaml .
looprail run
```

**Adapt it:**
- The default goal researches looprail's own repo. Replace the sentence
  describing the subject in `goal:` with your own topic.
- `checker` is deliberately not a cheap-tier model - catching a hallucinated
  or unsourced claim takes real reasoning, not a mechanical pattern match.
