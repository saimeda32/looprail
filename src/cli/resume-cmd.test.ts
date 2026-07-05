import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { resumeAction } from './resume-cmd.js'
import { runAction } from './run-cmd.js'
import { runsRoot } from './status-cmd.js'
import { MockAdapter, createRegistry, type Adapter, type AgentResult } from '../index.js'

const FIXTURE = `
name: resume-fixture
goal: Say DONE.
agents:
  worker:  { adapter: mock }
  checker: { adapter: mock }
graph:
  do:   { role: executor, agent: worker }
  crit: { role: critic, agent: checker, of: do, after: do }
rails:
  max_iterations: 1
  max_cost_usd: 5
`

function capture() {
  const lines: string[] = []
  return { io: { out: (l: string) => lines.push(l) }, lines }
}

function failingRegistry() {
  const registry = createRegistry()
  registry.register(new MockAdapter([
    { match: /EXECUTOR/, output: 'still working', costUsd: 1 },
    { match: /CRITIC/, output: 'VERDICT: fail\nEVIDENCE: not done yet', costUsd: 0.2 },
  ]))
  return registry
}

function passingRegistry() {
  const registry = createRegistry()
  registry.register(new MockAdapter([
    { match: /EXECUTOR/, output: 'DONE', costUsd: 1 },
    { match: /CRITIC/, output: 'VERDICT: pass\nEVIDENCE: ok', costUsd: 0.2 },
  ]))
  return registry
}

function throwingRegistry() {
  const registry = createRegistry()
  const boom: Adapter = { name: 'mock', invoke: async () => { throw new Error('must not be called') } }
  registry.register(boom)
  return registry
}

async function haltedRun(): Promise<{ cwd: string; runId: string }> {
  const cwd = mkdtempSync(join(tmpdir(), 'lr-resume-'))
  writeFileSync(join(cwd, 'looprail.yaml'), FIXTURE)
  const { io, lines } = capture()
  const code = await runAction(undefined, { cwd, json: true }, { io, registry: failingRegistry() })
  expect(code).toBe(2) // halted: max_iterations: 1 breached without a passing verdict
  const runId = (JSON.parse(lines.at(-1)!) as { runId: string }).runId
  return { cwd, runId }
}

test('resume reuses the exact same runId, instead of forking a new run', async () => {
  const { cwd, runId } = await haltedRun()
  const { io, lines } = capture()
  const code = await resumeAction(runId, { cwd, json: true, maxIterations: 3 }, { io, registry: passingRegistry() })
  expect(code).toBe(0)
  const summary = JSON.parse(lines.at(-1)!) as { runId: string; status: string; iterations: number }
  expect(summary.runId).toBe(runId)
  expect(summary.status).toBe('verified')
  // continues counting from where the halted run left off (iteration 1),
  // rather than restarting the counter at 1 again
  expect(summary.iterations).toBe(2)
})

test('resume carries the halted run\'s critic feedback into the next prompt and does not replay it from cache', async () => {
  const { cwd, runId } = await haltedRun()
  const registry = createRegistry()
  const mock = new MockAdapter([
    { match: /EXECUTOR/, output: 'DONE', costUsd: 1 },
    { match: /CRITIC/, output: 'VERDICT: pass\nEVIDENCE: ok', costUsd: 0.2 },
  ])
  registry.register(mock)
  const code = await resumeAction(runId, { cwd, json: true, maxIterations: 3 }, { io: capture().io, registry })
  expect(code).toBe(0)
  // a stale cache replay would mean the executor is never actually
  // re-invoked - it is a real call (plus the critic, plus the final
  // report's narration call), and it must see the reason the run halted
  // last time
  expect(mock.calls).toHaveLength(3)
  expect(mock.calls[0].prompt).toContain('not done yet')
})

test('resume with raised max_iterations lets a run that already breached its old limit keep going and verify', async () => {
  const { cwd, runId } = await haltedRun()
  const { io, lines } = capture()
  const code = await resumeAction(runId, { cwd, json: true, maxIterations: 5 }, { io, registry: passingRegistry() })
  expect(code).toBe(0)
  expect((JSON.parse(lines.at(-1)!) as { status: string }).status).toBe('verified')
})

test('resume without an override keeps the original rails, so it halts again immediately without calling any adapter', async () => {
  const { cwd, runId } = await haltedRun()
  const { io, lines } = capture()
  const code = await resumeAction(runId, { cwd, json: true }, { io, registry: throwingRegistry() })
  expect(code).toBe(2)
  expect((JSON.parse(lines.at(-1)!) as { reason: string }).reason).toContain('iterations')
})

test('resume reports how many cached node results it loaded from the prior run', async () => {
  const { cwd, runId } = await haltedRun()
  const { io, lines } = capture()
  await resumeAction(runId, { cwd, json: true, maxIterations: 3 }, { io, registry: passingRegistry() })
  expect(lines.join('\n')).toContain('cached')
})

test('resume with raised max_wall_minutes lets a run that already breached its old limit keep going and verify', async () => {
  const { cwd, runId } = await haltedRun()
  const { io, lines } = capture()
  const code = await resumeAction(runId, { cwd, json: true, maxIterations: 3, maxWallMinutes: 60 }, { io, registry: passingRegistry() })
  expect(code).toBe(0)
  expect((JSON.parse(lines.at(-1)!) as { status: string }).status).toBe('verified')
})

test('resume without a maxWallMinutes override leaves the loopfile\'s own rails.max_wall_minutes untouched', async () => {
  const { cwd, runId } = await haltedRun()
  const { io, lines } = capture()
  await resumeAction(runId, { cwd, json: true, maxIterations: 3 }, { io, registry: passingRegistry() })
  // FIXTURE has no max_wall_minutes, so the announced rails summary must not
  // silently invent one when no override is provided.
  expect(lines.join('\n')).not.toContain('undefinedmin')
})

test('resume with no runs exits 1', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'lr-resume-empty-'))
  const { io, lines } = capture()
  expect(await resumeAction(undefined, { cwd }, { io })).toBe(1)
  expect(lines.join('\n')).toContain('no runs')
})

test('resume writes a fresh pid file before invoking any node, so the resumed run is controllable again', async () => {
  const { cwd, runId } = await haltedRun()
  const runDir = join(runsRoot(cwd), runId)
  let sawPid = false
  const registry = createRegistry()
  const pidCheckingAdapter: Adapter = {
    name: 'mock',
    invoke: async (req): Promise<AgentResult> => {
      sawPid = sawPid || existsSync(join(runDir, 'pid'))
      const pass = /CRITIC/.test(req.prompt)
      return { output: pass ? 'VERDICT: pass\nEVIDENCE: ok' : 'DONE', costUsd: 0.1, tokens: 0, durationMs: 1 }
    },
  }
  registry.register(pidCheckingAdapter)
  const code = await resumeAction(runId, { cwd, json: true, maxIterations: 3 }, { io: capture().io, registry })
  expect(code).toBe(0)
  expect(sawPid).toBe(true)
  expect(existsSync(join(runDir, 'pid'))).toBe(false) // cleaned up after completion
})

test("resume refreshes the run's own persisted loopfile.json copy too, not just a fresh `run` - so a later dashboard read still shows the graph even after this workspace is deleted", async () => {
  const { cwd, runId } = await haltedRun()
  const runDir = join(runsRoot(cwd), runId)
  const code = await resumeAction(runId, { cwd, json: true, maxIterations: 3 }, { io: capture().io, registry: passingRegistry() })
  expect(code).toBe(0)

  const { rmSync } = await import('node:fs')
  rmSync(cwd, { recursive: true, force: true })

  const { loadRunLoopDef } = await import('../journal/loopfile-persist.js')
  const persisted = loadRunLoopDef(runDir)
  expect(persisted?.nodes.map((n) => n.id).sort()).toEqual(['crit', 'do'])
  expect(persisted?.agents.worker).toEqual({ adapter: 'mock' })
})
