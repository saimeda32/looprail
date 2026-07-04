import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { replayAction } from './replay-cmd.js'
import { runAction } from './run-cmd.js'
import { MockAdapter, createRegistry, type Adapter } from '../index.js'

const FIXTURE = `
name: replay-fixture
goal: Say DONE.
agents:
  worker:  { adapter: mock }
  checker: { adapter: mock }
graph:
  do:   { role: executor, agent: worker }
  crit: { role: critic, agent: checker, of: do, after: do }
rails:
  max_iterations: 2
  max_cost_usd: 5
`

function capture() {
  const lines: string[] = []
  return { io: { out: (l: string) => lines.push(l) }, lines }
}

function scriptedRegistry() {
  const registry = createRegistry()
  registry.register(new MockAdapter([
    { match: /EXECUTOR/, output: 'DONE', costUsd: 1 },
    { match: /CRITIC/, output: 'VERDICT: pass\nEVIDENCE: ok', costUsd: 0.2 },
  ]))
  return registry
}

function throwingRegistry() {
  const registry = createRegistry()
  const boom: Adapter = {
    name: 'mock',
    invoke: async () => { throw new Error('replay must not invoke adapters') },
  }
  registry.register(boom)
  return registry
}

async function recordedRun() {
  const cwd = mkdtempSync(join(tmpdir(), 'lr-replay-'))
  writeFileSync(join(cwd, 'looprail.yaml'), FIXTURE)
  const code = await runAction(undefined, { cwd, json: true }, {
    io: capture().io, registry: scriptedRegistry(),
  })
  expect(code).toBe(0)
  return cwd
}

test('replay of the latest run reuses cached results at zero cost', async () => {
  const cwd = await recordedRun()
  const { io, lines } = capture()
  const code = await replayAction(undefined, { cwd, json: true }, {
    io, registry: throwingRegistry(),
  })
  expect(code).toBe(0)
  const summary = JSON.parse(lines.at(-1)!) as { status: string; costUsd: number }
  expect(summary.status).toBe('verified')
  expect(summary.costUsd).toBe(0)
  expect(lines.join('\n')).toContain('cached')
})

test('editing the goal invalidates the cache and re-executes live', async () => {
  const cwd = await recordedRun()
  writeFileSync(join(cwd, 'looprail.yaml'), FIXTURE.replace('Say DONE.', 'Say PONG.'))
  const { io, lines } = capture()
  const code = await replayAction(undefined, { cwd, json: true }, {
    io, registry: scriptedRegistry(), // fresh script - replay must invoke it
  })
  expect(code).toBe(0)
  const summary = JSON.parse(lines.at(-1)!) as { costUsd: number }
  expect(summary.costUsd).toBeCloseTo(1.2)
})

test('replay with no runs exits 1', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'lr-replay-'))
  const { io, lines } = capture()
  expect(await replayAction(undefined, { cwd }, { io })).toBe(1)
  expect(lines.join('\n')).toContain('no runs')
})

test('replay without a loopfile in cwd exits 1 with guidance', async () => {
  const cwd = await recordedRun()
  const { io, lines } = capture()
  expect(await replayAction(undefined, { cwd, file: 'missing.yaml' }, { io })).toBe(1)
  expect(lines.join('\n')).toContain('missing.yaml')
})
