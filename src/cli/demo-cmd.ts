import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Command } from 'commander'
import { runAction } from './run-cmd.js'
import { defaultIo, dim, heading, type CliIo } from './ui.js'

// A zero-config, zero-API-key first run. The single biggest barrier to
// trying looprail is "install five agent CLIs, log them all in, then write
// a loopfile" - so `looprail demo` shows the whole thing (plan -> build ->
// real tester -> independent critic -> verified) end to end in seconds
// using only the built-in mock adapter, in a throwaway temp directory,
// with the live dashboard open. Nothing is written to the user's project
// and no model is ever called. It is the 30-second "so THAT'S what it
// does" moment before anyone has committed to anything.
const DEMO_LOOPFILE = `name: looprail-demo
goal: |
  A guided demo of a full looprail loop - no API key, no real agent needed.
  A planner drafts an approach, an executor "builds" it, a REAL tester runs
  an actual command, and an independent critic reviews the result. The loop
  stops only when every check passes. (Everything here uses the built-in
  mock adapter, so it runs offline and instantly - swap 'mock' for
  'claude-code' or 'codex' to point it at a real agent.)

agents:
  builder:  { adapter: mock }
  reviewer: { adapter: mock }

graph:
  plan:  { role: planner, agent: builder }
  build: { role: executor, agent: builder, after: plan }
  test:  { role: tester, after: build, run: "true", expect: exit 0 }
  crit:  { role: critic, agent: reviewer, of: build, after: test,
           prompt: Confirm the build satisfies the goal and no check was weakened. }

rails:
  max_iterations: 3
  max_cost_usd: 1

verdict: { policy: all-pass }
`

export interface DemoDeps {
  io?: CliIo
  // Seam so the test can assert the demo runs without opening a real
  // dashboard or spawning anything - defaults to the real runAction.
  run?: typeof runAction
  // Injectable temp dir so the test controls where the throwaway project
  // lands; defaults to a fresh OS temp directory.
  makeDir?: () => string
}

export async function demoAction(opts: { ui?: boolean } = {}, deps: DemoDeps = {}): Promise<number> {
  const io = deps.io ?? defaultIo
  const run = deps.run ?? runAction
  const dir = (deps.makeDir ?? (() => mkdtempSync(join(tmpdir(), 'looprail-demo-'))))()
  writeFileSync(join(dir, 'looprail.yaml'), DEMO_LOOPFILE)

  io.out(heading('looprail demo'))
  io.out(dim('  a full verified loop on the built-in mock adapter - no API key, nothing touched in your project'))
  io.out(dim(`  (running in ${dir})`))
  io.out('')

  const code = await run(undefined, { cwd: dir, ui: opts.ui }, { io })

  io.out('')
  io.out(dim('  that is the whole loop: plan -> build -> real test -> independent critic -> verified.'))
  io.out(dim('  next: `looprail init` in your own project to scaffold one against a real agent.'))
  return code
}

export function registerDemo(program: Command): void {
  program
    .command('demo')
    .description('run a full verified loop on the built-in mock adapter - no API key, nothing installed, ~instant')
    .option('--ui', 'open the live dashboard for the demo run')
    .action(async (opts: { ui?: boolean }) => {
      process.exitCode = await demoAction(opts)
    })
}
