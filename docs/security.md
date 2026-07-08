# Security, permissions, and isolation

Looprail shells out to agent CLIs you already trust. What each of those
agents is allowed to do, and what looprail does and does not isolate, is
spelled out here - the honest version, not the reassuring one.

## Agent permissions

Each agent's `permissions` picks how much it's allowed to do on its own,
independent of which model it runs:

```yaml
agents:
  worker: { adapter: claude-code, model: sonnet, permissions: safe }
```

`safe` accepts edits but keeps the adapter's own sandbox for anything
riskier; `standard` turns that sandboxing off; `full` also skips the
adapter's own approval gating entirely. Leaving `permissions` unset
reproduces each adapter's own pre-existing default (`safe` for
claude-code/codex/aider; `full` for copilot-cli, which had no
sandboxed mode to begin with) - set it explicitly rather than relying on
that, since `full` is real reduced safety, not just less prompting.

Looprail runs every agent non-interactively (no stdin attached), so for
most adapters "riskier" still just means the adapter's own CLI denies or
errors on the action - there is no live prompt to answer. There is one
mechanism that can relay a real, live prompt back to you: if an adapter is
wired with a `permissionDetector` (see `src/adapters/cli-adapter.ts`), a
node whose underlying agent CLI subprocess blocks mid-execution waiting on
its own tool-permission prompt has that prompt surfaced as an approvable
moment right in the dashboard's live-output panel for that node, and your
answer is relayed back into that exact subprocess's stdin so the CLI
continues instead of failing or auto-denying. This is genuinely distinct
from a loopfile's own `role: gate` node: a gate pauses the ENGINE between
nodes (nothing is running while it waits); a mid-node permission prompt
happens *inside* an already-running node's own subprocess, with the
scheduler untouched and no other node affected.

This chain (detect → surface in the dashboard → answer → relay into the
subprocess's stdin) is demonstrated end-to-end in
`src/engine/permission-e2e.test.ts`, exercised against a `MockAdapter`
standing in for the CLI subprocess. None of the four real adapters
(claude-code, codex, copilot-cli, aider) has a `permissionDetector` wired
up yet - each adapter file has a code comment explaining why: live
investigation with the real installed `claude`/`copilot` CLIs could not
confirm an actual permission-prompt output shape to detect, and the
codex/aider binaries weren't even installed to test against, so nothing
was invented. Wiring a real detector for any of them is deferred until
that shape can be verified against the real CLI's actual output.

## Security and isolation

The honest version, not the reassuring one:

- **No API keys or credentials ever touch looprail.** It shells out to the
  agent CLI you already logged into (`claude`, `codex`, `aider`, `gh
  copilot`) the same way you'd run it yourself - looprail never sees, stores,
  or transmits a key.
- **Looprail does not sandbox anything itself.** It has no container, no VM,
  no filesystem jail of its own. Whatever isolation a node's execution has
  comes entirely from the underlying adapter CLI's own sandboxing (see
  [Agent permissions](#agent-permissions) above) - a `full`-permissions
  agent can do anything your OS user account can do, in your real working
  directory, on your real filesystem. Treat `permissions: full` as exactly
  as risky as running that CLI yourself with its safety flags off, because
  that is literally what it is.
- **Each node runs as its own OS subprocess**, so one hanging or crashing
  node doesn't take down the loop - a wall-clock rail forcibly kills a node
  that outlives its budget (see [Rails](loopfile-reference.md#rails))
  instead of hanging forever.
  That's process isolation for reliability, not a security boundary.
- **A `role: gate` node is the one real, engine-level control point**: it
  pauses the whole loop, mid-graph, for an explicit human yes/no before
  anything past it runs - useful for "review the plan before any code gets
  touched," not a sandbox around what runs after you approve it.
- **The mid-node permission relay is new and unproven against real CLIs
  yet** - see [Agent permissions](#agent-permissions) above for exactly
  what's shipped (the mechanism, proven against a mock adapter) versus
  what's deliberately deferred (a real detector for any of the four actual
  adapter CLIs, since none of their real permission-prompt output could be
  confirmed without inventing a format).

If your threat model needs an actual sandbox around agent execution
(untrusted input, a multi-tenant setting, code you don't trust running with
your full permissions), put looprail's subprocess inside your own
container/VM boundary - that's a deliberate design choice to stay a thin
orchestration layer over whatever agent CLI and OS-level isolation you
already trust, not a gap we're hiding.
