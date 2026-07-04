import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { loadCache } from './cache.js'
import { runLoop } from '../engine/runner.js'
import { MockAdapter } from '../adapters/mock.js'
import { createRegistry } from '../adapters/registry.js'
import type { LoopDef } from '../core/types.js'

const loop: LoopDef = {
  name: 'demo', goal: 'g',
  agents: { a: { adapter: 'mock' } },
  nodes: [
    { id: 'do', role: 'executor', agent: 'a' },
    { id: 'crit', role: 'critic', agent: 'a', of: 'do', after: ['do'] },
  ],
  rails: { maxIterations: 2, maxCostUsd: 5 },
  verdictPolicy: { kind: 'all-pass' },
}
const script = () => new MockAdapter([
  { match: /EXECUTOR/, output: 'DONE', costUsd: 1 },
  { match: /CRITIC/, output: 'VERDICT: pass\nEVIDENCE: ok', costUsd: 0.2 },
])

test('replay with loaded cache skips agent calls and costs nothing', async () => {
  const runDir = join(mkdtempSync(join(tmpdir(), 'lr-')), 'run')
  const registry = createRegistry()
  registry.register(script())
  const first = await runLoop(loop, { registry, runDir })
  expect(first.costUsd).toBeCloseTo(1.2)

  const cache = loadCache(join(runDir, 'journal.jsonl'))
  expect(cache.size).toBe(2)

  const replayRegistry = createRegistry()
  replayRegistry.register(new MockAdapter([])) // would throw if invoked
  const replay = await runLoop(loop, { registry: replayRegistry, cache })
  expect(replay.status).toBe('verified')
  expect(replay.costUsd).toBe(0)
})

test('loadCache with excludeIteration drops that iteration\'s outcomes but keeps every other iteration cached', async () => {
  const runDir = join(mkdtempSync(join(tmpdir(), 'lr-')), 'run')
  const registry = createRegistry()
  registry.register(new MockAdapter([
    { match: /EXECUTOR/, output: 'attempt 1' },
    { match: /CRITIC/, output: 'VERDICT: fail\nEVIDENCE: no' },
    { match: /EXECUTOR/, output: 'attempt 2' },
    { match: /CRITIC/, output: 'VERDICT: fail\nEVIDENCE: still no' },
  ]))
  const first = await runLoop(loop, { registry, runDir })
  expect(first.status).toBe('halted')

  const fullCache = loadCache(join(runDir, 'journal.jsonl'))
  const withoutIteration2 = loadCache(join(runDir, 'journal.jsonl'), { excludeIteration: 2 })
  expect(withoutIteration2.size).toBe(fullCache.size - 2) // do + crit from iteration 2 dropped
  for (const [hash, outcome] of fullCache) {
    if (outcome.output === 'attempt 1') expect(withoutIteration2.get(hash)).toEqual(outcome)
  }
})

test('editing the goal invalidates the cache (different context hash)', async () => {
  const runDir = join(mkdtempSync(join(tmpdir(), 'lr-')), 'run')
  const registry = createRegistry()
  registry.register(script())
  await runLoop(loop, { registry, runDir })
  const cache = loadCache(join(runDir, 'journal.jsonl'))

  const edited = { ...loop, goal: 'a different goal' }
  const freshRegistry = createRegistry()
  freshRegistry.register(script())
  const rerun = await runLoop(edited, { registry: freshRegistry, cache })
  expect(rerun.costUsd).toBeCloseTo(1.2) // nothing reused
})
