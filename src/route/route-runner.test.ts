import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse } from 'yaml'
import { expect, test } from 'vitest'
import { createRegistry } from '../adapters/registry.js'
import type { Adapter } from '../core/types.js'
import { runRoute } from './route-runner.js'
import type { RouteVariant } from './types.js'

const BASE = `
name: fixture
goal: produce DONE
agents:
  worker:  { adapter: mock }
  checker: { adapter: mock }
graph:
  do:   { role: executor, agent: worker }
  crit: { role: critic, agent: checker, of: do, after: do }
rails:
  max_iterations: 1
  max_cost_usd: 5
verdict: { policy: all-pass }
`

function fakeAdapter(name: string, costPerCall: number): Adapter {
  return {
    name,
    async invoke(req) {
      return {
        output: req.prompt.includes('CRITIC') ? 'VERDICT: pass\nEVIDENCE: ok' : 'DONE',
        costUsd: costPerCall, tokens: 10, durationMs: 1,
      }
    },
  }
}

function variant(id: string, adapter: string, model?: string): RouteVariant {
  const engine = model ? { adapter, model } : { adapter }
  return { id, agents: { worker: { ...engine }, checker: { ...engine } } }
}

function dirs() {
  return {
    runsRoot: mkdtempSync(join(tmpdir(), 'looprail-route-runs-')),
    variantsDir: mkdtempSync(join(tmpdir(), 'looprail-route-variants-')),
  }
}

function registryWith(...adapters: Adapter[]) {
  const reg = createRegistry()
  for (const a of adapters) reg.register(a)
  return reg
}

test('runs every variant through the bench machinery and measures each one', async () => {
  const registry = registryWith(fakeAdapter('claude-code', 0.4), fakeAdapter('codex', 0.1))
  const result = await runRoute(
    BASE,
    [variant('claude-code-sonnet', 'claude-code', 'sonnet'), variant('codex', 'codex')],
    5,
    { registry, ...dirs() },
  )
  expect(result.entries).toHaveLength(2)
  for (const e of result.entries) {
    expect(e.skipped).toBe(false)
    expect(e.verified).toBe(true)
    expect(e.iterations).toBe(1)
    expect(e.tokens).toBe(20) // executor + critic, 10 each
    expect(e.wallMs).toBeGreaterThanOrEqual(0)
  }
  expect(result.spentUsd).toBeCloseTo(0.8 + 0.2, 5)
})

test('entries come back ranked: verified first, then cheapest', async () => {
  const registry = registryWith(fakeAdapter('claude-code', 0.4), fakeAdapter('codex', 0.1))
  const result = await runRoute(
    BASE,
    [variant('claude-code-sonnet', 'claude-code', 'sonnet'), variant('codex', 'codex')],
    5,
    { registry, ...dirs() },
  )
  expect(result.entries[0].variant.id).toBe('codex')
  expect(result.entries[1].variant.id).toBe('claude-code-sonnet')
})

test('stops launching variants once the budget is spent, keeping them as skipped entries', async () => {
  // each full run costs $4 (2 calls x $2) against a $5 total budget:
  // v1 spends 4, v2 launches with only $1 of rail left and halts partway,
  // v3 must never launch at all
  const registry = registryWith(fakeAdapter('claude-code', 2))
  const { runsRoot, variantsDir } = dirs()
  const result = await runRoute(
    BASE,
    [
      variant('claude-code-sonnet', 'claude-code', 'sonnet'),
      variant('claude-code-opus', 'claude-code', 'opus'),
      variant('claude-code-haiku', 'claude-code', 'haiku'),
    ],
    5,
    { registry, runsRoot, variantsDir },
  )
  const byId = new Map(result.entries.map((e) => [e.variant.id, e]))
  expect(byId.get('claude-code-sonnet')!.verified).toBe(true)
  expect(byId.get('claude-code-opus')!.skipped).toBe(false)
  expect(byId.get('claude-code-opus')!.verified).toBe(false)
  expect(byId.get('claude-code-haiku')!.skipped).toBe(true)
  // skipped variants carry no measurements and rank last
  expect(result.entries[result.entries.length - 1].variant.id).toBe('claude-code-haiku')
  expect(byId.get('claude-code-haiku')!.costUsd).toBeUndefined()
})

test('each launched variant\'s own cost rail is clamped to the budget still remaining', async () => {
  const registry = registryWith(fakeAdapter('claude-code', 2))
  const { runsRoot, variantsDir } = dirs()
  await runRoute(
    BASE,
    [variant('claude-code-sonnet', 'claude-code', 'sonnet'), variant('claude-code-opus', 'claude-code', 'opus')],
    5,
    { registry, runsRoot, variantsDir },
  )
  const first = parse(readFileSync(join(variantsDir, 'claude-code-sonnet.yaml'), 'utf8')) as {
    rails: { max_cost_usd: number }; agents: Record<string, { adapter: string; model?: string }>
  }
  const second = parse(readFileSync(join(variantsDir, 'claude-code-opus.yaml'), 'utf8')) as {
    rails: { max_cost_usd: number }
  }
  // never looser than the loopfile's own rail, never looser than what's left
  expect(first.rails.max_cost_usd).toBe(5)
  expect(second.rails.max_cost_usd).toBe(1)
  // the written variant re-points agents but keeps the graph intact
  expect(first.agents.worker).toEqual({ adapter: 'claude-code', model: 'sonnet' })
})

test('estimated-only spend counts against the budget exactly as the engine\'s own rail does', async () => {
  const estimating: Adapter = {
    name: 'claude-code',
    async invoke(req) {
      return {
        output: req.prompt.includes('CRITIC') ? 'VERDICT: pass\nEVIDENCE: ok' : 'DONE',
        costUsd: 0, estimatedCostUsd: 3, tokens: 10, durationMs: 1,
      }
    },
  }
  const result = await runRoute(
    BASE,
    [variant('claude-code-sonnet', 'claude-code', 'sonnet'), variant('claude-code-opus', 'claude-code', 'opus')],
    5,
    { registry: registryWith(estimating), ...dirs() },
  )
  // v1's two calls estimate $6 total, over the $5 budget -> v2 never launches
  const byId = new Map(result.entries.map((e) => [e.variant.id, e]))
  expect(byId.get('claude-code-opus')!.skipped).toBe(true)
})

test('announces each variant as it launches', async () => {
  const registry = registryWith(fakeAdapter('codex', 0.1))
  const started: string[] = []
  await runRoute(BASE, [variant('codex', 'codex')], 5, {
    registry, ...dirs(), onVariantStart: (id) => started.push(id),
  })
  expect(started).toEqual(['codex'])
})
