# Contributing

Thanks for taking a look. Bug reports, questions, and pull requests are all
welcome.

## Setup

You need Node 20 or newer.

```bash
git clone git@github.com:saimeda32/looprail.git
cd looprail
npm install
npm test
```

## Working on it

- `npm test` runs the whole suite with vitest.
- `npm run test:watch` reruns tests as you edit.
- `npm run build` compiles TypeScript to `dist/`.
- `npm run e2e` builds the CLI and runs a small end-to-end check against the
  mock adapter, which needs no agent installed.

The tests use a mock adapter, so you do not need a real agent CLI installed
to run them. Project layout:

| Path | What's there |
| --- | --- |
| `src/core` | Types, the Loopfile-adjacent domain model, rails, pricing |
| `src/engine` | The scheduler and runner - the actual loop |
| `src/adapters` | One file per agent CLI (claude-code, codex, aider, copilot-cli, shell, mock) |
| `src/config` | Loopfile parsing and the linter |
| `src/cli` | Commander-based CLI subcommands |
| `src/dashboard` | The live dashboard (single-run and mission control) |
| `src/journal` | Run history: journaling, caching, resume/replay |
| `src/mcp` | The MCP server and its tools |
| `examples/` | Copy-paste example loopfiles, one folder each with its own README |
| `benchmarks/` | The `looprail bench` A/B harness and its mock-backed fixtures |

## Before opening a pull request

- **Add a test for anything you change.** The suite runs in a few seconds,
  so there's no reason not to. A bug fix should include a test that fails
  without the fix and passes with it - that's the actual proof it's fixed,
  not just that the suite stays green.
- **Keep the diff focused on one thing.** A bug fix PR shouldn't also
  refactor an unrelated function it happened to pass through.
- **Match this codebase's existing conventions** rather than introducing a
  new one - comment style (a comment explains a non-obvious *why*, not what
  the code already says), naming, and file organization. Look at a
  neighboring file in the same directory before writing a new one.
- **Run `npm test` and `npm run build` before you push.** There's no CI gate
  yet to catch this for you.
- For a change large enough to need discussion first (a new adapter, a new
  engine capability, anything touching the Loopfile schema), open an issue
  before writing the code - it's a much shorter conversation before the
  work is done than after.

### Commit messages

This repo uses a `type(scope): summary` convention (`feat`, `fix`, `docs`,
`chore`, `ci`, `test`) - look at `git log` for real examples. The summary
line explains *why* a change was made or what problem it solves, not just
what changed; the diff itself already shows what changed.

## Reporting bugs

Open an issue with the loopfile you ran, the exact command, and what
happened versus what you expected. If a run misbehaved, the journal
`looprail status <runId>` points you to under `~/.looprail/runs/` is the
single most useful thing to attach - it has the full per-node context,
verdicts, and cost for that run.

Security issues: please don't open a public issue for anything you believe
is exploitable. Email the maintainer instead (see the repository's commit
history for a contact) so it can be fixed before it's disclosed.
