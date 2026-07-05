# self-planning

Give looprail a plain-English goal instead of a hand-written graph, and let
a planner propose the graph itself - reviewed by a different model, then
paused for your explicit approval before any of it actually runs.

**What it demonstrates:** `generates: graph` on the `plan` node - its output
is parsed as a loopfile fragment (agents/rails/graph) instead of prose, then
spliced into the live run once the `approve` gate lets it through. `review`
is on a different model (`gpt-5.3-codex`) than `plan` (`claude-sonnet-5`) on
purpose - the same-model-reviewing-itself problem this whole example is
trying to avoid at the graph level.

**Run it:**

```bash
cp examples/self-planning/looprail.yaml .
looprail run --ui
```

At the `approve` gate, you'll see the proposed graph before anything in it
executes - reject or edit it if it's wrong, rather than rubber-stamping.

**Adapt it:** replace the `goal:` placeholder with what you actually want
built. `replan_limit: 3` and `gate_timeout: 600` are both worth raising for
a genuinely large or open-ended goal.
