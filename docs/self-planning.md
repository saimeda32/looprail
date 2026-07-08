# Self-planning loops

You don't always have to write the graph yourself. A planner node with
`generates: graph` proposes one from a plain-English goal instead of prose:

```yaml
agents:
  planner:  { adapter: claude-code, model: opus }
  reviewer: { adapter: codex }              # different model, catches what the planner's own review misses

graph:
  plan:    { role: planner, agent: planner, generates: graph,
             prompt: Propose a graph of nodes that would implement the goal above. }
  review:  { role: critic, agent: reviewer, of: plan, after: plan }
  approve: { role: gate, after: review }    # pauses for you before anything the plan proposes actually runs
```

The planner's reply is parsed as a loopfile fragment, reviewed by a
different model, and spliced into the live graph only after the `approve`
gate lets it through - reject or edit it there if it's wrong, rather than
rubber-stamping it. See [`examples/self-planning`](../examples/self-planning)
for a runnable version. On a re-plan, the planner can reply with a compact
`edits:` block targeting just what changed instead of re-emitting the whole
graph, which cuts the output-token cost of a retry by 80%+ on a typical fix.

## Spec intake: `--from-spec`

The same machinery has a front door for written requirements:

```bash
looprail init --from-spec prd.md
```

scaffolds a self-planning loop that implements a written spec, with
requirement-coverage review and a plan-approval gate: the planner turns the
spec into a graph, a critic on a different model checks the plan against
every requirement in the document, and a `gate` node holds the run until
you approve the plan - so nothing executes against a spec you haven't
signed off on. See [`examples/implement-spec`](../examples/implement-spec)
for the full shape as a standalone loopfile.
