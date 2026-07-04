import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { runLoop } from './runner.js'
import { readJournal } from '../journal/journal.js'
import { MockAdapter } from '../adapters/mock.js'
import { createRegistry } from '../adapters/registry.js'
import type { AgentResult, LoopDef } from '../core/types.js'

const loop = (over: Partial<LoopDef> = {}): LoopDef => ({
  name: 'demo',
  goal: 'produce the word DONE',
  agents: { a: { adapter: 'mock' } },
  nodes: [
    { id: 'plan', role: 'planner', agent: 'a' },
    { id: 'pcrit', role: 'critic', agent: 'a', of: 'plan', after: ['plan'], rounds: 2 },
    { id: 'do', role: 'executor', agent: 'a', after: ['pcrit'] },
    { id: 'crit', role: 'critic', agent: 'a', of: 'do', after: ['do'] },
  ],
  rails: { maxIterations: 4, maxCostUsd: 5, stallAfter: 2, replanLimit: 1 },
  verdictPolicy: { kind: 'all-pass' },
  ...over,
})

const reg = (mock: MockAdapter) => {
  const registry = createRegistry()
  registry.register(mock)
  return registry
}

test('verifies when critics pass on first iteration', async () => {
  const mock = new MockAdapter([
    { match: /PLANNER/, output: 'the plan' },
    { match: /CRITIC/, output: 'VERDICT: pass\nEVIDENCE: plan is sound' },
    { match: /EXECUTOR/, output: 'DONE', costUsd: 0.5 },
    { match: /CRITIC/, output: 'VERDICT: pass\nEVIDENCE: verified DONE' },
  ])
  const report = await runLoop(loop(), { registry: reg(mock) })
  expect(report.status).toBe('verified')
  expect(report.iterations).toBe(1)
  expect(report.costUsd).toBeCloseTo(0.5)
})

test('failed verdict feeds evidence into next iteration executor prompt', async () => {
  const mock = new MockAdapter([
    { match: /PLANNER/, output: 'the plan' },
    { match: /CRITIC/, output: 'VERDICT: pass\nEVIDENCE: ok' },
    { match: /EXECUTOR/, output: 'half done' },
    { match: /CRITIC/, output: 'VERDICT: fail\nEVIDENCE: missing the DONE marker' },
    { match: /EXECUTOR/, output: 'DONE' },
    { match: /CRITIC/, output: 'VERDICT: pass\nEVIDENCE: ok now' },
  ])
  const report = await runLoop(loop(), { registry: reg(mock) })
  expect(report.status).toBe('verified')
  expect(report.iterations).toBe(2)
  const secondExec = mock.calls.filter((c) => c.prompt.includes('EXECUTOR'))[1]
  expect(secondExec.prompt).toContain('missing the DONE marker')
})

test('planner revision round runs when plan critic fails', async () => {
  const mock = new MockAdapter([
    { match: /PLANNER/, output: 'weak plan' },
    { match: /CRITIC/, output: 'VERDICT: fail\nEVIDENCE: no success criteria' },
    { match: /PLANNER/, output: 'strong plan' },
    { match: /CRITIC/, output: 'VERDICT: pass\nEVIDENCE: fixed' },
    { match: /EXECUTOR/, output: 'DONE' },
    { match: /CRITIC/, output: 'VERDICT: pass\nEVIDENCE: ok' },
  ])
  const report = await runLoop(loop(), { registry: reg(mock) })
  expect(report.status).toBe('verified')
  const plannerCalls = mock.calls.filter((c) => c.prompt.includes('PLANNER'))
  expect(plannerCalls).toHaveLength(2)
  expect(plannerCalls[1].prompt).toContain('no success criteria')
})

test('halts on iteration rail with a report, never throws', async () => {
  const steps = [
    { match: /PLANNER/, output: 'plan' },
    { match: /CRITIC/, output: 'VERDICT: pass\nEVIDENCE: ok' },
  ]
  for (let i = 0; i < 4; i++) {
    steps.push(
      { match: /EXECUTOR/, output: `attempt ${i}` },
      { match: /CRITIC/, output: `VERDICT: fail\nEVIDENCE: wrong attempt ${i}` },
    )
  }
  // no stall_after on these rails: identical failing sets must NOT stall —
  // this test exercises the iteration rail in isolation
  const def = loop({ rails: { maxIterations: 4, maxCostUsd: 5 } })
  const report = await runLoop(def, { registry: reg(new MockAdapter(steps)) })
  expect(report.status).toBe('halted')
  expect(report.iterations).toBe(5) // breach detected entering iteration 5
  expect(report.reason).toContain('iterations')
})

test('stall triggers replan, then halts when stall persists', async () => {
  const mock = new MockAdapter([
    { match: /PLANNER/, output: 'plan' },
    { match: /CRITIC/, output: 'VERDICT: pass\nEVIDENCE: ok' },
    { match: /EXECUTOR/, output: 'x' },
    { match: /CRITIC/, output: 'VERDICT: fail\nEVIDENCE: same wall' },
    { match: /EXECUTOR/, output: 'x' },
    { match: /CRITIC/, output: 'VERDICT: fail\nEVIDENCE: same wall' },
    { match: /PLANNER/, output: 'plan B' },          // replan after stall
    { match: /CRITIC/, output: 'VERDICT: pass\nEVIDENCE: ok' },
    { match: /EXECUTOR/, output: 'x' },
    { match: /CRITIC/, output: 'VERDICT: fail\nEVIDENCE: same wall' },
    { match: /EXECUTOR/, output: 'x' },
    { match: /CRITIC/, output: 'VERDICT: fail\nEVIDENCE: same wall' },
  ])
  const report = await runLoop(loop(), { registry: reg(mock) })
  expect(report.status).toBe('halted')
  expect(report.reason).toContain('stall')
  expect(report.replans).toBe(1)
})

test('journals run lifecycle when runDir is set', async () => {
  const mock = new MockAdapter([
    { match: /PLANNER/, output: 'plan' },
    { match: /CRITIC/, output: 'VERDICT: pass\nEVIDENCE: ok' },
    { match: /EXECUTOR/, output: 'DONE' },
    { match: /CRITIC/, output: 'VERDICT: pass\nEVIDENCE: ok' },
  ])
  const runDir = join(mkdtempSync(join(tmpdir(), 'lr-')), 'run')
  const report = await runLoop(loop(), { registry: reg(mock), runDir, runId: 'r1' })
  const types = readJournal(join(runDir, 'journal.jsonl')).map((e) => e.type)
  expect(types[0]).toBe('run_start')
  expect(types).toContain('node_end')
  expect(types.at(-1)).toBe('verified')
  expect(report.runId).toBe('r1')
})

test('planner with "after" pointing at an execution node runs without crashing', async () => {
  const mock = new MockAdapter([
    { match: /PLANNER/, output: 'the plan' },
    { match: /EXECUTOR/, output: 'DONE' },
    { match: /CRITIC/, output: 'VERDICT: pass\nEVIDENCE: ok' },
  ])
  const def = loop({
    nodes: [
      { id: 'plan', role: 'planner', agent: 'a', after: ['research'] },
      { id: 'research', role: 'executor', agent: 'a' },
      { id: 'crit', role: 'critic', agent: 'a', of: 'research', after: ['research'] },
    ],
  })
  const report = await runLoop(def, { registry: reg(mock) })
  expect(report.status).toBe('verified')
})

test('verifies when the cost rail breaches during the same iteration the loop passes', async () => {
  const mock = new MockAdapter([
    { match: /EXECUTOR/, output: 'DONE', costUsd: 0.5 },
    { match: /CRITIC/, output: 'VERDICT: pass\nEVIDENCE: ok', costUsd: 0.6 },
  ])
  const def = loop({
    nodes: [
      { id: 'do', role: 'executor', agent: 'a' },
      { id: 'crit', role: 'critic', agent: 'a', of: 'do', after: ['do'] },
    ],
    rails: { maxIterations: 4, maxCostUsd: 1.0 },
  })
  const report = await runLoop(def, { registry: reg(mock) })
  expect(report.status).toBe('verified')
  expect(report.costUsd).toBeCloseTo(1.1)
})

test('denies verified when a rail-skipped node leaves verification incomplete', async () => {
  // repro: do($0.6) -> crit(pass, $0.5) -> judge(threshold, would fail if run)
  // max_cost_usd 1.0 breaches after crit, so judge is skipped pre-start.
  // aggregating only the outcomes present (do, crit) yields an all-pass
  // verdict set, but the judge — a configured verifier — never ran.
  const mock = new MockAdapter([
    { match: /EXECUTOR/, output: 'DONE', costUsd: 0.6 },
    { match: /CRITIC/, output: 'VERDICT: pass\nEVIDENCE: ok', costUsd: 0.5 },
    // no JUDGE step: if the judge were ever invoked, the mock would throw
    // "exhausted" instead of naturally reporting a fail-worthy low score
  ])
  const def = loop({
    nodes: [
      { id: 'do', role: 'executor', agent: 'a' },
      { id: 'crit', role: 'critic', agent: 'a', of: 'do', after: ['do'] },
      { id: 'judge', role: 'judge', agent: 'a', of: 'do', after: ['crit'], threshold: 0.9 },
    ],
    rails: { maxIterations: 4, maxCostUsd: 1.0 },
  })
  const runDir = join(mkdtempSync(join(tmpdir(), 'lr-')), 'run')
  const report = await runLoop(def, { registry: reg(mock), runDir })

  expect(report.status).toBe('halted')
  expect(report.reason).toContain('rail breached (cost)')
  expect(report.reason).toContain('skipped')
  expect(mock.calls).toHaveLength(2) // judge's adapter was never invoked
  expect(mock.calls.some((c) => c.prompt.includes('JUDGE'))).toBe(false)

  const events = readJournal(join(runDir, 'journal.jsonl'))
  const skip = events.find((e) => e.type === 'node_skipped' && e.data.nodeId === 'judge')
  expect(skip).toBeTruthy()
  expect(skip?.data.role).toBe('judge')
  expect(skip?.data.iteration).toBe(1)
})

test('critic-of-critic whose "of" target is unreachable halts loudly on the first iteration, not after riding out the iteration rail', async () => {
  // C1/I4: an "of" target that can never resolve (here: metacrit lives in
  // the execution region while pcrit only exists in the planning region's
  // outcomes) is a structural graph bug — it reproduces identically on every
  // iteration, so it must halt immediately with the target named rather than
  // being softened into a failure that iterates until the iteration rail.
  const mock = new MockAdapter([
    { match: /PLANNER/, output: 'plan' },
    { match: /CRITIC/, output: 'VERDICT: pass\nEVIDENCE: ok' },
    { match: /EXECUTOR/, output: 'DONE' },
  ])
  const def = loop({
    nodes: [
      { id: 'plan', role: 'planner', agent: 'a' },
      { id: 'pcrit', role: 'critic', agent: 'a', of: 'plan', after: ['plan'] },
      { id: 'do', role: 'executor', agent: 'a' },
      { id: 'metacrit', role: 'critic', agent: 'a', of: 'pcrit' },
    ],
  })
  const report = await runLoop(def, { registry: reg(mock), sleep: async () => {} })
  expect(report.status).toBe('halted')
  expect(report.iterations).toBe(1)
  expect(report.reason).toContain('metacrit')
  expect(report.reason).toContain('"pcrit"')
})

test('loop halts immediately when a node references an unregistered adapter, instead of iterating', async () => {
  const mock = new MockAdapter([])
  const def = loop({
    agents: { a: { adapter: 'mock' }, b: { adapter: 'ghost-adapter' } },
    nodes: [
      { id: 'do', role: 'executor', agent: 'b' },
    ],
    rails: { maxIterations: 4, maxCostUsd: 5 },
  })
  const report = await runLoop(def, { registry: reg(mock), sleep: async () => {} })
  expect(report.status).toBe('halted')
  expect(report.iterations).toBe(1) // halted on the first iteration, did not ride out the rail
  expect(report.reason).toContain('do')
  expect(report.reason).toContain('ghost-adapter')
})

test('a genuinely transient adapter error survives retries and iterates like a failure, not halting immediately', async () => {
  // proves the fix did not over-correct: with no config: or infra: tag, the
  // error still routes like a failure and rides out the iteration rail.
  const mock = new MockAdapter([
    { match: /EXECUTOR/, output: 'DONE' },
    { match: /EXECUTOR/, output: 'DONE' },
  ])
  const def = loop({
    nodes: [
      { id: 'do', role: 'executor', agent: 'a' },
      { id: 'crit', role: 'critic', agent: 'a', of: 'do', after: ['do'] },
    ],
    rails: { maxIterations: 2, maxCostUsd: 5 },
  })
  const report = await runLoop(def, { registry: reg(mock), sleep: async () => {} })
  expect(report.status).toBe('halted')
  expect(report.reason).toContain('iterations')
  expect(mock.calls.filter((c) => c.prompt.includes('EXECUTOR'))).toHaveLength(2)
})

test('halts before starting a node that would run past the cost rail', async () => {
  const mock = new MockAdapter([
    { match: /step1/, output: 'one', costUsd: 0.5 },
    { match: /step2/, output: 'two', costUsd: 0.5 },
    { match: /step3/, output: 'three', costUsd: 0.5 },
  ])
  const def = loop({
    nodes: [
      { id: 's1', role: 'executor', agent: 'a', prompt: 'step1' },
      { id: 's2', role: 'executor', agent: 'a', prompt: 'step2', after: ['s1'] },
      { id: 's3', role: 'executor', agent: 'a', prompt: 'step3', after: ['s2'] },
    ],
    rails: { maxIterations: 4, maxCostUsd: 1.0 },
  })
  const report = await runLoop(def, { registry: reg(mock) })
  expect(report.status).toBe('halted')
  expect(report.reason).toContain('cost')
  expect(mock.calls).toHaveLength(2) // s3's adapter was never invoked
  expect(mock.calls.some((c) => c.prompt.includes('step3'))).toBe(false)
})

test('a node with no timeout_ms is clamped to the remaining wall budget, so a hung adapter cannot outlive the wall rail', async () => {
  // Without the clamp, the executor below (no timeoutMs) receives an undefined
  // timeout and its "subprocess" never returns — the run would hang forever,
  // because the wall rail is only checked between nodes. With the clamp, the
  // node inherits the remaining wall budget as its timeout and fails, handing
  // control back so the wall rail can fire. If this regresses, the test hangs
  // and trips vitest's own timeout rather than passing.
  const registry = createRegistry()
  registry.register({
    name: 'mock',
    async invoke(req) {
      if (req.prompt.includes('EXECUTOR')) {
        if (req.timeoutMs === undefined) return new Promise<AgentResult>(() => {}) // hangs forever
        // honor the deadline the way a real subprocess timeout would
        return new Promise<AgentResult>((_, reject) =>
          setTimeout(() => reject(new Error('subprocess timed out')), req.timeoutMs))
      }
      return { output: 'VERDICT: pass\nEVIDENCE: ok', costUsd: 0, tokens: 0, durationMs: 1 }
    },
  })
  const def = loop({
    nodes: [
      { id: 'do', role: 'executor', agent: 'a' },
      { id: 'crit', role: 'critic', agent: 'a', of: 'do', after: ['do'] },
    ],
    rails: { maxIterations: 5, maxCostUsd: 5, maxWallMinutes: 0.003 }, // 180ms budget
  })
  const report = await runLoop(def, { registry, retries: 0, sleep: async () => {} })
  expect(report.status).toBe('halted')
  expect(report.reason).toMatch(/wall|iterations/)
})

test('no wall rail means a node with no timeout_ms still gets no timeout (unchanged behavior)', async () => {
  let seenTimeout: number | undefined = -1
  const registry = createRegistry()
  registry.register({
    name: 'mock',
    async invoke(req) {
      if (req.prompt.includes('EXECUTOR')) seenTimeout = req.timeoutMs
      return {
        output: req.prompt.includes('CRITIC') ? 'VERDICT: pass\nEVIDENCE: ok' : 'DONE',
        costUsd: 0, tokens: 0, durationMs: 1,
      }
    },
  })
  const def = loop({
    nodes: [
      { id: 'do', role: 'executor', agent: 'a' },
      { id: 'crit', role: 'critic', agent: 'a', of: 'do', after: ['do'] },
    ],
    rails: { maxIterations: 2, maxCostUsd: 5 }, // no maxWallMinutes
  })
  const report = await runLoop(def, { registry })
  expect(report.status).toBe('verified')
  expect(seenTimeout).toBeUndefined()
})

test('journal emits node_start before node_end, both stamped with the iteration', async () => {
  const mock = new MockAdapter([
    { match: /EXECUTOR/, output: 'DONE' },
    { match: /CRITIC/, output: 'VERDICT: pass\nEVIDENCE: ok' },
  ])
  const def = loop({
    nodes: [
      { id: 'do', role: 'executor', agent: 'a' },
      { id: 'crit', role: 'critic', agent: 'a', of: 'do', after: ['do'] },
    ],
  })
  const runDir = join(mkdtempSync(join(tmpdir(), 'lr-')), 'run')
  await runLoop(def, { registry: reg(mock), runDir })
  const events = readJournal(join(runDir, 'journal.jsonl'))
  for (const id of ['do', 'crit']) {
    const startIdx = events.findIndex((e) => e.type === 'node_start' && e.data.nodeId === id)
    const endIdx = events.findIndex((e) => e.type === 'node_end' && e.data.nodeId === id)
    expect(startIdx).toBeGreaterThanOrEqual(0)
    expect(endIdx).toBeGreaterThan(startIdx)
    expect(events[startIdx].data.iteration).toBe(1)
    expect(events[endIdx].data.iteration).toBe(1)
  }
})

test('throws on invalid graph', async () => {
  const bad = loop({ nodes: [{ id: 'x', role: 'executor', agent: 'ghost' }] })
  await expect(runLoop(bad, { registry: reg(new MockAdapter([])) })).rejects.toThrow(/ghost/)
})

test('auth failure halts the run with a doctor hint', async () => {
  const registry = createRegistry()
  registry.register({
    name: 'mock',
    invoke: async () => { throw new Error('HTTP 401 unauthorized — please login') },
  })
  const report = await runLoop(loop(), { registry, sleep: async () => {} })
  expect(report.status).toBe('halted')
  expect(report.reason).toContain('doctor')
})

test('onEvent streams lifecycle events even without a runDir', async () => {
  const mock = new MockAdapter([
    { match: /PLANNER/, output: 'plan' },
    { match: /CRITIC/, output: 'VERDICT: pass\nEVIDENCE: ok' },
    { match: /EXECUTOR/, output: 'DONE' },
    { match: /CRITIC/, output: 'VERDICT: pass\nEVIDENCE: ok' },
  ])
  const seen: string[] = []
  const report = await runLoop(loop(), {
    registry: reg(mock), onEvent: (e) => seen.push(e.type),
  })
  expect(report.status).toBe('verified')
  expect(seen[0]).toBe('run_start')
  expect(seen).toContain('node_start')
  expect(seen).toContain('node_end')
  expect(seen.at(-1)).toBe('verified')
})

test('transient errors route like failures: the loop keeps iterating', async () => {
  let execCalls = 0
  const registry = createRegistry()
  registry.register({
    name: 'mock',
    async invoke(req) {
      if (req.prompt.includes('EXECUTOR')) {
        execCalls++
        throw new Error('rate limit exceeded, retry later')
      }
      return {
        output: req.prompt.includes('VERDICT:')
          ? 'VERDICT: pass\nEVIDENCE: ok' : 'the plan',
        costUsd: 0, tokens: 0, durationMs: 1,
      }
    },
  })
  const def = loop({ rails: { maxIterations: 2, maxCostUsd: 5 } })
  const report = await runLoop(def, { registry, retries: 0, sleep: async () => {} })
  expect(report.status).toBe('halted')
  expect(report.reason).toContain('iterations')
  expect(execCalls).toBe(2) // iterated after the first error instead of halting
})

test('node_progress events are journaled and streamed live as adapters produce partial output', async () => {
  const registry = createRegistry()
  registry.register({
    name: 'mock',
    async invoke(req, onChunk) {
      onChunk?.('chunk-a ')
      onChunk?.('chunk-b')
      return {
        output: req.prompt.includes('CRITIC') ? 'VERDICT: pass\nEVIDENCE: ok' : 'DONE',
        costUsd: 0, tokens: 0, durationMs: 1,
      }
    },
  })
  const runDir = join(mkdtempSync(join(tmpdir(), 'lr-')), 'run')
  const def = loop({
    nodes: [
      { id: 'do', role: 'executor', agent: 'a' },
      { id: 'crit', role: 'critic', agent: 'a', of: 'do', after: ['do'] },
    ],
  })
  await runLoop(def, { registry, runDir })
  const events = readJournal(join(runDir, 'journal.jsonl'))
  const progress = events.filter((e) => e.type === 'node_progress' && e.data.nodeId === 'do')
  expect(progress.map((e) => e.data.chunk)).toEqual(['chunk-a ', 'chunk-b'])
  expect(progress[0].data.role).toBe('executor')
  expect(progress[0].data.iteration).toBe(1)
})

test('a loop with no streaming adapter never emits node_progress (opt-in, zero overhead)', async () => {
  const mock = new MockAdapter([
    { match: /EXECUTOR/, output: 'DONE' },
    { match: /CRITIC/, output: 'VERDICT: pass\nEVIDENCE: ok' },
  ])
  const def = loop({
    nodes: [
      { id: 'do', role: 'executor', agent: 'a' },
      { id: 'crit', role: 'critic', agent: 'a', of: 'do', after: ['do'] },
    ],
  })
  const seen: string[] = []
  await runLoop(def, { registry: reg(mock), onEvent: (e) => seen.push(e.type) })
  expect(seen).not.toContain('node_progress')
})
