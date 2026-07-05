# review-diff

A read-only adversarial review of whatever you currently have staged or
unstaged - no code changes are made. Useful as a second pair of eyes before
you open a PR.

**What it demonstrates:** the smallest useful two-node shape - `review` then
`crit` - where the critic doesn't just check the review's formatting, it
re-examines the same `git diff` independently and fails if the review missed
a real issue or flagged a non-issue. Nothing here writes to your working
tree.

**Run it:**

```bash
cd /path/to/your/repo-with-a-pending-diff
cp /path/to/looprail/examples/review-diff/looprail.yaml .
looprail run
```

**Adapt it:** this one works as-is for most repos - the `git diff` command
in the prompts is what actually gets reviewed, so just make sure you run it
from the directory with the pending changes you want checked.
