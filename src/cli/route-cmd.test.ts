import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { createRegistry } from '../adapters/registry.js'
import type { DetectedAgent } from '../adapters/detect.js'
import type { Adapter } from '../core/types.js'
import { routeAction } from './route-cmd.js'
import type { CliIo } from './ui.js'

function captureIo(): { io: CliIo; lines: string[] } {
  const lines: string[] = []
  return { io: { out: (l) => lines.push(l) }, lines }
}

const LOOPFILE = `
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

function scaffold(): string {
  const dir = mkdtempSync(join(tmpdir(), 'looprail-route-cmd-'))
  writeFileSync(join(dir, 'looprail.yaml'), LOOPFILE)
  return dir
}

function detected(adapter: string, available = true): DetectedAgent {
  return { name: adapter, adapter, command: adapter, available, fixHint: 'install it' }
}

function fakeAdapter(name: string, costPerCall: number, verdict = 'pass'): { adapter: Adapter; calls: () => number } {
  let calls = 0
  const adapter: Adapter = {
    name,
    async invoke(req) {
      calls++
      return {
        output: req.prompt.includes('CRITIC') ? `VERDICT: ${verdict}\nEVIDENCE: ok` : 'DONE',
        costUsd: costPerCall, tokens: 10, durationMs: 1,
      }
    },
  }
  return { adapter, calls: () => calls }
}

function registryDeps(verdict = 'pass') {
  const claude = fakeAdapter('claude-code', 0.4, verdict)
  const codex = fakeAdapter('codex', 0.1, verdict)
  const registry = createRegistry()
  registry.register(claude.adapter)
  registry.register(codex.adapter)
  return { registry, claude, codex }
}

const detectBoth = async () => [detected('claude-code'), detected('codex')]

test('prints the generated variants and refuses to run when confirmation is declined', async () => {
  const cwd = scaffold()
  const { io, lines } = captureIo()
  const { registry, claude, codex } = registryDeps()
  const asked: string[] = []
  const code = await routeAction(undefined, { cwd }, {
    io, registry, detect: detectBoth,
    confirm: async (q) => { asked.push(q); return false },
  })
  expect(code).toBe(1)
  expect(asked).toHaveLength(1)
  expect(lines.join('\n')).toContain('claude-code-sonnet+critic-codex')
  // nothing launched, nothing persisted
  expect(claude.calls() + codex.calls()).toBe(0)
  expect(existsSync(join(cwd, '.looprail', 'routing.json'))).toBe(false)
})

test('--yes runs without asking and writes .looprail/routing.json with the winner', async () => {
  const cwd = scaffold()
  const { io, lines } = captureIo()
  const { registry } = registryDeps()
  const asked: string[] = []
  const code = await routeAction(undefined, { cwd, yes: true }, {
    io, registry, detect: detectBoth,
    confirm: async (q) => { asked.push(q); return false },
    now: () => Date.parse('2026-07-06T00:00:00.000Z'),
  })
  expect(code).toBe(0)
  expect(asked).toHaveLength(0)
  const routing = JSON.parse(readFileSync(join(cwd, '.looprail', 'routing.json'), 'utf8'))
  expect(routing.benchmarkedAt).toBe('2026-07-06T00:00:00.000Z')
  // every variant costs the same here, so the stable rank keeps generation
  // order: the first variant (claude worker, codex critic) is the winner
  expect(routing.recommendedAgents.worker.adapter).toBe('claude-code')
  expect(routing.recommendedAgents.checker.adapter).toBe('codex')
  expect(routing.results.length).toBeGreaterThanOrEqual(2)
  expect(lines.join('\n')).toContain('variant')
})

test('--json prints the same object that was persisted', async () => {
  const cwd = scaffold()
  const { io, lines } = captureIo()
  const { registry } = registryDeps()
  const code = await routeAction(undefined, { cwd, yes: true, json: true }, { io, registry, detect: detectBoth })
  expect(code).toBe(0)
  const printed = JSON.parse(lines[lines.length - 1])
  const persisted = JSON.parse(readFileSync(join(cwd, '.looprail', 'routing.json'), 'utf8'))
  expect(printed).toEqual(persisted)
})

test('--variants caps how many configs are generated and run', async () => {
  const cwd = scaffold()
  const { io } = captureIo()
  const { registry } = registryDeps()
  const code = await routeAction(undefined, { cwd, yes: true, variants: 2 }, { io, registry, detect: detectBoth })
  expect(code).toBe(0)
  const routing = JSON.parse(readFileSync(join(cwd, '.looprail', 'routing.json'), 'utf8'))
  expect(routing.results).toHaveLength(2)
})

test('exits 2 when no variant verified, but still records what was measured', async () => {
  const cwd = scaffold()
  const { io } = captureIo()
  const { registry } = registryDeps('fail')
  const code = await routeAction(undefined, { cwd, yes: true }, { io, registry, detect: detectBoth })
  expect(code).toBe(2)
  const routing = JSON.parse(readFileSync(join(cwd, '.looprail', 'routing.json'), 'utf8'))
  expect(routing.results.every((r: { verified?: boolean }) => r.verified !== true)).toBe(true)
})

test('missing loopfile exits 1 with a clear error', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'looprail-route-cmd-empty-'))
  const { io, lines } = captureIo()
  const code = await routeAction(undefined, { cwd, yes: true }, { io, registry: createRegistry(), detect: detectBoth })
  expect(code).toBe(1)
  expect(lines.join('\n')).toContain('no loopfile at')
})

test('no installed adapters exits 1 without running anything', async () => {
  const cwd = scaffold()
  const { io, lines } = captureIo()
  const code = await routeAction(undefined, { cwd, yes: true }, {
    io, registry: createRegistry(),
    detect: async () => [detected('claude-code', false)],
  })
  expect(code).toBe(1)
  expect(lines.join('\n')).toContain('no agent CLI found')
})
