# looprail

Vendor-neutral orchestrator for agentic loops. You declare *what done means*
— a goal, the roles that pursue it, the verifiers that prove it, and the
rails that bound it — and looprail drives any agent CLI (Claude Code, Codex,
aider, Copilot, any shell command) through that loop until the work is
verified or a rail is hit.

Prompt engineering tells the model what to do; looprail is where you engineer
the loop that decides when it's actually done.

## 60-second quickstart

```sh
npx looprail init   # detects your agent CLIs, scaffolds looprail.yaml
npx looprail run    # runs the loop until verified or a rail halts it
```

No API keys: adapters reuse each CLI's existing login. `looprail doctor`
tells you exactly which adapter is missing and the one command that fixes it.

## Commands

| Command | What it does | Exit codes |
|---|---|---|
| `looprail init` | scaffold a loopfile from the template gallery (`--template`, `--agent`, `--reviewer`, `--yes`, `--force`) | 0 / 1 |
| `looprail run [file]` | run until verified or halted (`--json`, `--yes`) | 0 verified / 2 halted / 1 error |
| `looprail doctor` | which agent CLIs are installed + how to fix the rest | 0 / 1 none |
| `looprail lint <file>` | static loop-design checks (L001-L006) | 0 / 1 errors |
| `looprail status [runId]` | run report from the journal (`--watch`) | 0 / 1 |
| `looprail logs [runId] [node]` | node outputs from a run journal | 0 / 1 |
| `looprail explain <file> <node>` | exact context a node would receive | 0 / 1 |
| `looprail replay [runId]` | re-run with cached results — edit one prompt, pay only for downstream | 0 / 2 / 1 |
| `looprail resume [runId]` | continue an interrupted run (v1: replay semantics — cached prefix + live remainder) | 0 / 2 / 1 |

Every command accepts a global `--cwd <dir>` to point at a project directory
other than the current one.

## Adapters

`claude-code` (headless `claude -p`), `codex` (`codex exec`), `aider`,
`copilot-cli` (`gh copilot`), `shell` (any command template — the universal
escape hatch), `mock` (deterministic, offline, free).

## Try it offline

```sh
npm run build
node dist/cli/index.js run examples/mock-demo/looprail.yaml
```

## SDK

The same engine is importable: `import { runLoop, parseLoopfile, createDefaultRegistry } from 'looprail'`.

MIT.
