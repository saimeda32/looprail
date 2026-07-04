import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { runBench } from './bench-runner.js'
import { createRegistry } from '../adapters/registry.js'
import { MockAdapter } from '../adapters/mock.js'
import type { Adapter } from '../core/types.js'
import type { BenchDef } from './types.js'

const LOOPFILE = (agentAdapter: string) => `
name: fixture
goal: produce DONE
agents:
  a: { adapter: ${agentAdapter} }
graph:
  do:   { role: executor, agent: a }
  crit: { role: critic, agent: a, of: do, after: do }
rails:
  max_iterations: 1
  max_cost_usd: 5
verdict: { policy: all-pass }
`

function scaffold(agentAdapter = 'mock'): string {
  const dir = mkdtempSync(join(tmpdir(), 'looprail-bench-runner-'))
  writeFileSync(join(dir, 'x.yaml'), LOOPFILE(agentAdapter))
  return dir
}

function benchDef(over: Partial<BenchDef> = {}): BenchDef {
  return {
    name: 'demo', task: 'demo task', repeat: 3,
    configs: [{ id: 'only', loopfile: 'x.yaml' }],
    ...over,
  }
}

function passingRegistry() {
  const reg = createRegistry()
  reg.register(new MockAdapter([
    { match: /EXECUTOR/, output: 'DONE' },
    { match: /CRITIC/, output: 'VERDICT: pass\nEVIDENCE: ok' },
  ]))
  return reg
}

test('runs each config `repeat` times and aggregates one result per config', async () => {
  const dir = scaffold()
  const runsRoot = mkdtempSync(join(tmpdir(), 'looprail-bench-runs-'))
  const result = await runBench(benchDef(), dir, { registryFor: passingRegistry, runsRoot })
  expect(result.configs).toHaveLength(1)
  expect(result.configs[0].runs).toHaveLength(3)
  expect(result.configs[0].stats.n).toBe(3)
  expect(result.configs[0].stats.passRate).toBe(1)
})

test('detects mock mode when every agent uses the mock adapter', async () => {
  const dir = scaffold('mock')
  const runsRoot = mkdtempSync(join(tmpdir(), 'looprail-bench-runs-'))
  const result = await runBench(benchDef(), dir, { registryFor: passingRegistry, runsRoot })
  expect(result.configs[0].mode).toBe('mock')
})

test('detects real mode when any agent uses a non-mock adapter', async () => {
  const dir = scaffold('fake')
  const runsRoot = mkdtempSync(join(tmpdir(), 'looprail-bench-runs-'))
  const fakeAdapter: Adapter = {
    name: 'fake',
    async invoke(req) {
      return {
        output: req.prompt.includes('CRITIC') ? 'VERDICT: pass\nEVIDENCE: ok' : 'DONE',
        costUsd: 0, tokens: 0, durationMs: 1,
      }
    },
  }
  const registry = createRegistry()
  registry.register(fakeAdapter)
  const result = await runBench(benchDef(), dir, { registry, runsRoot })
  expect(result.configs[0].mode).toBe('real')
})

test('passes a fresh registry per run via registryFor, keyed by config id and run index', async () => {
  const dir = scaffold()
  const runsRoot = mkdtempSync(join(tmpdir(), 'looprail-bench-runs-'))
  const seen: [string, number][] = []
  const registryFor = (configId: string, i: number) => {
    seen.push([configId, i])
    return passingRegistry()
  }
  await runBench(benchDef({ repeat: 2 }), dir, { registryFor, runsRoot })
  expect(seen).toEqual([['only', 0], ['only', 1]])
})

test('measures wallMs from the injected clock, not the real clock', async () => {
  const dir = scaffold()
  const runsRoot = mkdtempSync(join(tmpdir(), 'looprail-bench-runs-'))
  let t = 0
  const now = () => (t += 10)
  const result = await runBench(benchDef({ repeat: 1 }), dir, { registryFor: passingRegistry, runsRoot, now })
  expect(result.configs[0].runs[0].wallMs).toBeGreaterThan(0)
  expect(Number.isFinite(result.configs[0].runs[0].wallMs)).toBe(true)
})

test('each run writes and reads back its own journal', async () => {
  const dir = scaffold()
  const runsRoot = mkdtempSync(join(tmpdir(), 'looprail-bench-runs-'))
  const result = await runBench(benchDef({ repeat: 1 }), dir, { registryFor: passingRegistry, runsRoot })
  const events = result.configs[0].runs[0].events
  expect(events.some((e) => e.type === 'run_start')).toBe(true)
  expect(events.some((e) => e.type === 'verified')).toBe(true)
})

test('throws when neither registry nor registryFor is supplied', async () => {
  const dir = scaffold()
  const runsRoot = mkdtempSync(join(tmpdir(), 'looprail-bench-runs-'))
  await expect(runBench(benchDef(), dir, { runsRoot } as never)).rejects.toThrow(/registry/)
})
