# overnight-queue

Queue three real jobs before you leave, come back to a triage table: two
verified with independent test/critic evidence, one parked at its human
gate waiting for your go/no-go - nothing hung, nothing needed you at 3am.

**What it demonstrates:** the workflow a bare agent CLI structurally cannot
offer. `looprail queue` runs items sequentially and unattended; goal-only
items reuse one loopfile's graph shape (`looprail.yaml`: worker + real
tester + anti-gaming critic) with per-item goals, and `release-check.yaml`
ends at a `role: gate` whose `gate_timeout` PARKS the run - resumable, zero
repeated work - instead of blocking the queue overnight. Every verified
item carries a journal: what ran, what the tester executed, what the critic
checked.

**Run it:**

```bash
cp examples/overnight-queue/*.yaml .
looprail queue          # reads ./queue.yaml; add --gate-timeout <sec> to tune parking
```

In the morning:

```bash
# the triage table printed at the end shows parked items' exact resume command
looprail resume <parked-run-id>   # the gate asks again; prior work is cached
looprail ui --all                 # or answer it from mission control
```

**Adapt it:** replace the two `goal:` items in `queue.yaml` with your own
backlog (each needs testable success criteria - the tester and critic hold
the line while you sleep), and point `looprail.yaml`'s `run: npm test` at
your stack's real test command. Add as many items as you like; budget rails
(`max_cost_usd`, `max_wall_minutes`) cap each item independently.
