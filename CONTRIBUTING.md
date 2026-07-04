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

The tests use a mock adapter, so you do not need a real agent CLI to run them.
The engine lives in `src/core` and `src/engine`, the adapters in
`src/adapters`, the CLI in `src/cli`, and the Loopfile parser and linter in
`src/config`.

## Pull requests

- Add a test for anything you change. The suite runs fast, so there is no
  reason not to.
- Keep the diff focused on one thing.
- Run `npm test` and `npm run build` before you push.

## Reporting bugs

Open an issue with the Loopfile you ran, the command, and what happened. If a
run misbehaved, the journal `looprail status <runId>` points you to under
`~/.looprail/runs/` is the most useful thing to attach.
