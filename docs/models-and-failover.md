# Mixing models, failover, and routing

Looprail is vendor-neutral by construction: every node names which agent
runs it, so a loop can mix providers - and measure which mix is actually
best - instead of living inside one lab's CLI.

## Mixing models

Every `agents:` entry names an `adapter:` - which CLI actually runs that
agent. `looprail doctor` shows which of these it found installed and
logged in on your machine, and `looprail doctor --models` lists the models
each installed CLI can run - enumerated live from the CLI itself wherever it
offers a way (codex, copilot, aider, ollama), with an honest `static` marker
where it doesn't (claude has no enumeration command):

| Adapter | Wraps | Install / login | Notes |
| --- | --- | --- | --- |
| `claude-code` | Claude Code CLI (`claude`) | `npm i -g @anthropic-ai/claude-code`, then run `claude` once to log in | `model:` accepts a tier name (`opus`/`sonnet`/`haiku`) or a full model string |
| `codex` | OpenAI Codex CLI (`codex`) | `npm i -g @openai/codex`, then `codex login` | |
| `copilot-cli` | GitHub Copilot CLI (`gh`) | Install the GitHub CLI, then `gh auth login` and `gh extension install github/gh-copilot` | model strings use dots (`claude-opus-4.8`), not the dashed form some other adapters use |
| `aider` | [aider](https://aider.chat) | Install aider, set your provider's API key env var | reports no real dollar cost - looprail estimates one from its token counts instead |
| `gemini` | [Gemini CLI](https://github.com/google-gemini/gemini-cli) (`gemini`) | RETIRED for individual users (June 2026) - enterprise installs still work; individuals should use `antigravity` | reports no dollar cost - looprail estimates one from its token counts |
| `antigravity` | [Antigravity CLI](https://github.com/google-antigravity/antigravity-cli) (`agy`) - Google's Gemini CLI successor | `curl -fsSL https://antigravity.google/cli/install.sh \| bash`, then run `agy` once to log in | plain-text print mode: token counts are chars/4 estimates, cost is estimated from the pricing table |
| `opencode` | [opencode](https://opencode.ai) (`opencode`) | `npm i -g opencode-ai`, then `opencode auth login` | `model:` takes the `provider/model` form (e.g. `anthropic/claude-sonnet-4-5`) |
| `ollama` | [Ollama](https://ollama.com) local models (`ollama`) | install from ollama.com, then `ollama pull <model>` - no login | `model:` is required (e.g. `llama3`); cost is genuinely $0, token counts are chars/4 estimates |
| `shell` | any command you give it | nothing - it's your command | for a script or anything else with a CLI |
| `mock` | nothing (built in) | nothing | deterministic, zero-cost - for demos and this repo's own tests |

Each node picks which agent runs it, so you can shape a loop by cost and by
independence:

```yaml
agents:
  builder: { adapter: claude-code, model: opus }   # expensive, rare
  checker: { adapter: claude-code, model: haiku }  # cheap, frequent
  skeptic: { adapter: codex }                       # different provider
  local:   { adapter: ollama, model: llama3 }       # free, on your machine

graph:
  draft: { role: executor, agent: builder }
  crit:  { role: critic, of: draft, after: draft, panel: [checker, skeptic, local] }
  judge: { role: judge, agent: skeptic, after: crit, threshold: 0.85 }
```

A critic panel with one critic per provider gives you three different blind
spots instead of one. `looprail lint` warns when a judge uses the same model as
the executor it is grading.

Add `probe: true` to a panel to cut its cost on failing iterations: clone 1
runs first (with `panel: [a, b, c]` the first listed agent leads, so put the
cheapest reviewer there), and if it fails, the rest are skipped - under the
`all-pass` policy that iteration's outcome is already decided, so the skipped
reviews could not have changed anything. A pass is never thinned: to verify,
every clone must still run and pass. Probe only applies under `all-pass`
(under `quorum`/`weighted` one fail decides nothing, so the panel runs at
full width, and `looprail lint` tells you so).

```yaml
  crit: { role: critic, of: draft, after: draft, panel: [checker, skeptic, local], probe: true }
```

Looprail doesn't drive every agent tool the same way. Claude Code, Codex,
aider, GitHub Copilot, Gemini CLI, opencode, and Ollama each have a real
command-line mode looprail can shell out to and parse output from, so any of
them can run any node. Cursor
doesn't have that (it's an IDE, not a scriptable process), so it can't be
assigned a node - the only way Cursor or Claude Desktop connect to looprail is
the other direction, as an MCP client calling into looprail's own tools via
`looprail mcp` (see [MCP.md](MCP.md)).

## Rate-limit failover

An agent can name a `fallback:` - another `agents:` key to hand its work to
when the provider rate-limits it (HTTP 429s, quota/overload errors) and
looprail's own retries are exhausted:

```yaml
agents:
  worker:   { adapter: claude-code, model: sonnet, fallback: worker-b }
  worker-b: { adapter: copilot-cli, model: claude-sonnet-5 }
```

Only clearly rate-limit-shaped failures trigger the hop - anything else still
fails the node, so real errors stay loud. Chains follow (`a -> b -> c`) but
must not cycle, and the fallback key must exist; `looprail lint` rejects both
mistakes before a run ever depends on them. When a hop happens it is recorded
in the journal, and the node's result is attributed to the agent that actually
served the call - so cost and model info stay honest even on a night the
primary provider spent throttling you.

## Token cost: caching proxies

looprail wraps agent CLIs; it does not call model APIs directly, so it does
not implement prompt caching or context compression itself. But the CLIs it
runs read their own base-URL environment variables, so you can point them at
an optimizing/caching proxy (headroom, an LLM gateway, your own) and looprail
inherits the savings for free. Set the var globally before a run, or route a
single agent through a proxy with a per-agent `env:`:

```yaml
agents:
  # this worker's Claude calls go through a local caching proxy...
  worker:   { adapter: claude-code, model: sonnet,
              env: { ANTHROPIC_BASE_URL: "http://localhost:8787" } }
  # ...while the reviewer goes straight to the provider
  reviewer: { adapter: codex }
```

Independent of any proxy, looprail already minimizes what it *sends*: within a
run it caches each node's result and re-runs only the nodes whose own lineage
actually failed (an independent branch that passed is never rebuilt), and a
re-running executor revises its previous attempt instead of regenerating the
whole artifact from the goal. A proxy makes each call cheaper; looprail makes
the loop send fewer, smaller calls - the two compound.

## Benchmarks

`looprail bench <benchfile>` runs two or more named loop configs against the
same task, N times each, and reports pass rate, iterations to verified, cost,
wall time, and a wasted-work estimate per config, plus a one-line verdict:

```bash
looprail bench benchmarks/bug-fix-on-seeded-repo.bench.yaml
```

A benchfile names a task and points at ordinary loopfiles, one per config, so
nothing about a loop's definition changes to be benchmarked. Every report
labels each config's numbers `mock` or `real` based on which adapters
actually ran, and the three benchmarks committed under `benchmarks/` are
mock-backed, so `npm test` proves the whole harness end to end for free. See
[benchmarks/README.md](../benchmarks/README.md) for reading the report and
running the same fixtures against real agents.

## Empirical routing

`looprail route` answers "which adapter/model mix is actually best for THIS
repo's loop" with data instead of folklore. It takes your own `looprail.yaml`,
detects which agent CLIs are installed, and auto-generates variant configs of
the same loop - one per provider (plus each claude-code tier), with critics
paired to a different model than the worker whenever a second provider is
available - then runs each variant through the same bench machinery:

```bash
looprail route --variants 4 --max-cost-usd 5
```

These are real paid loops, so it asks before spending (skip with `--yes`) and
stops launching variants the moment the total budget is spent - each variant's
own `max_cost_usd` rail is also clamped to whatever budget remains. The report
ranks variants verified-first, then by cost, and the winner's agent map is
written to `.looprail/routing.json` (`--json` prints the same object) so other
tooling can consume the recommendation.
