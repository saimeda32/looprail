# content-pipeline

Draft → weighted critique → human sign-off. A style critic and a
fact-checking critic each vote with different weight, and even a passing
weighted score still waits for an explicit human approval before the loop
finishes.

**What it demonstrates:** the `weighted` verdict policy instead of
`all-pass` - `style` carries weight 1, `facts` carries weight 2, and
`approve` (a `gate` node) itself carries weight 2, so a human's approval
matters as much as the fact-check. The threshold (`{ weighted: 0.8 }`) means
80% of the total weight must pass, not every single check.

**Run it:**

```bash
cp examples/content-pipeline/looprail.yaml .
looprail run
```

When it reaches `approve`, the loop pauses for your y/n before finishing -
that's the human sign-off the goal describes.

**Adapt it:**
- Replace the sentence describing the subject in `goal:` to write about
  something else.
- `fact-editor` stays on a real model (not a cheap tier) because fact-
  checking needs real reasoning; `editor`'s style pass is bounded enough to
  weight lower instead.
