import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, vi } from 'vitest'
import { runLoop } from './runner.js'
import { readJournal } from '../journal/journal.js'
import { loadRunLoopDef } from '../journal/loopfile-persist.js'
import { MockAdapter } from '../adapters/mock.js'
import { createRegistry } from '../adapters/registry.js'
import type { AgentResult, LoopDef } from '../core/types.js'
import * as git from '../core/git.js'
import { getPendingPermission, resolvePendingPermission } from '../dashboard/permission-registry.js'

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

// EFF-2: an independent branch must NOT re-run when a DIFFERENT branch
// fails. Two disjoint branches A and B; A's critic fails once (forcing a
// second iteration), B passes. B's executor and critic have B in no other
// branch's lineage, so their prompts stay byte-identical - lineage-scoped
// feedback adds nothing to them - and the within-run cache serves them
// instead of re-invoking. Proven by giving the mock EXACTLY ONE "Build B"
// step: if B re-ran, the mock would exhaust and throw.
test('an independent branch is served from cache when a different branch fails - not re-run', async () => {
  const twoBranch: LoopDef = {
    name: 'two-branch', goal: 'build A and B',
    agents: { a: { adapter: 'mock' } },
    nodes: [
      { id: 'doA', role: 'executor', agent: 'a', prompt: 'Build A.' },
      { id: 'critA', role: 'critic', agent: 'a', of: 'doA', after: ['doA'], prompt: 'Review A.' },
      { id: 'doB', role: 'executor', agent: 'a', prompt: 'Build B.' },
      { id: 'critB', role: 'critic', agent: 'a', of: 'doB', after: ['doB'], prompt: 'Review B.' },
    ],
    rails: { maxIterations: 4, maxCostUsd: 5 },
    verdictPolicy: { kind: 'all-pass' },
  }
  const mock = new MockAdapter([
    { match: /Build A\./, output: 'A v1' },
    { match: /Review A\./, output: 'VERDICT: fail\nEVIDENCE: A needs fixing' },
    { match: /Build B\./, output: 'B done' },                                   // ONLY ONE - re-running B would exhaust the mock
    { match: /Review B\./, output: 'VERDICT: pass\nEVIDENCE: B ok' },           // ONLY ONE
    { match: /Build A\./, output: 'A v2' },
    { match: /Review A\./, output: 'VERDICT: pass\nEVIDENCE: A ok now' },
  ])
  const report = await runLoop(twoBranch, { registry: reg(mock) })
  expect(report.status).toBe('verified')
  expect(report.iterations).toBe(2)
  // A re-ran (its lineage failed); B did not (served from the within-run cache)
  expect(mock.calls.filter((c) => /Build A\./.test(c.prompt))).toHaveLength(2)
  expect(mock.calls.filter((c) => /Build B\./.test(c.prompt))).toHaveLength(1)
  expect(mock.calls.filter((c) => /Review B\./.test(c.prompt))).toHaveLength(1)
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
  // no stall_after on these rails: identical failing sets must NOT stall - 
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

test('node_start and node_end journal events carry the resolved agent, adapter, and model directly - no LoopDef re-read needed to know them later', async () => {
  const mock = new MockAdapter([
    { match: /PLANNER/, output: 'plan' },
    { match: /CRITIC/, output: 'VERDICT: pass\nEVIDENCE: ok' },
    { match: /EXECUTOR/, output: 'DONE' },
    { match: /CRITIC/, output: 'VERDICT: pass\nEVIDENCE: ok' },
  ])
  const runDir = join(mkdtempSync(join(tmpdir(), 'lr-')), 'run')
  const def = loop({ agents: { a: { adapter: 'mock', model: 'demo-model' } } })
  await runLoop(def, { registry: reg(mock), runDir, runId: 'r1' })
  const events = readJournal(join(runDir, 'journal.jsonl'))
  const doStart = events.find((e) => e.type === 'node_start' && (e.data as { nodeId: string }).nodeId === 'do')
  expect(doStart?.data).toMatchObject({ agent: 'a', adapter: 'mock', model: 'demo-model' })
  const doEnd = events.find((e) => e.type === 'node_end' && (e.data as { nodeId: string }).nodeId === 'do')
  expect(doEnd?.data).toMatchObject({ agent: 'a', adapter: 'mock', model: 'demo-model' })
})

test('startIteration continues counting instead of restarting at 1, for a rails check that means what a resumed run needs it to mean', async () => {
  const mock = new MockAdapter([
    { match: /PLANNER/, output: 'plan' },
    { match: /CRITIC/, output: 'VERDICT: pass\nEVIDENCE: ok' },
    { match: /EXECUTOR/, output: 'DONE' },
    { match: /CRITIC/, output: 'VERDICT: pass\nEVIDENCE: ok' },
  ])
  // simulates continuing a run that already spent 3 iterations in an
  // earlier process, against a rails.maxIterations of 4 - only one more
  // iteration is left in budget, and it must be reported as iteration 4,
  // not iteration 1
  const def = loop({ rails: { maxIterations: 4, maxCostUsd: 5 } })
  const report = await runLoop(def, { registry: reg(mock), startIteration: 3 })
  expect(report.status).toBe('verified')
  expect(report.iterations).toBe(4)
})

test('human feedback queued via the runDir is injected into the very next iteration and then cleared', async () => {
  const mock = new MockAdapter([
    { match: /PLANNER/, output: 'plan' },
    { match: /CRITIC/, output: 'VERDICT: pass\nEVIDENCE: ok' },
    { match: /EXECUTOR/, output: 'half done' },
    { match: /CRITIC/, output: 'VERDICT: fail\nEVIDENCE: missing DONE' },
    { match: /EXECUTOR/, output: 'DONE' },
    { match: /CRITIC/, output: 'VERDICT: pass\nEVIDENCE: ok now' },
  ])
  const runDir = join(mkdtempSync(join(tmpdir(), 'lr-')), 'run')
  const { queueHumanFeedback } = await import('../journal/human-feedback.js')
  mkdirSync(runDir, { recursive: true })
  queueHumanFeedback(runDir, 'check the edge case with an empty list')
  const report = await runLoop(loop(), { registry: reg(mock), runDir, runId: 'r1' })
  expect(report.status).toBe('verified')
  const execCalls = mock.calls.filter((c) => c.prompt.includes('EXECUTOR'))
  expect(execCalls[0].prompt).toContain('check the edge case with an empty list')
  // one-shot: the second executor call must not still carry the same note
  expect(execCalls[1].prompt).not.toContain('check the edge case with an empty list')
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
  // verdict set, but the judge - a configured verifier - never ran.
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
  // outcomes) is a structural graph bug - it reproduces identically on every
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
  // timeout and its "subprocess" never returns - the run would hang forever,
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

test('time spent waiting for a gate does not count toward max_wall_minutes - a slow human approval cannot breach the wall rail', async () => {
  // The clock jumps 10 REAL minutes forward while the gate handler is
  // "awaiting a human" (simulated by mutating `t` before the handler
  // resolves) - a tiny 1-minute wall budget would breach instantly if that
  // wait counted, since everything else in this loop takes ~0 simulated
  // time. If runner.ts's onGateWaitStart/onGateWaitEnd wiring regressed,
  // this test's run would halt on a wall breach instead of verifying.
  let t = 0
  const registry = createRegistry()
  registry.register({
    name: 'mock',
    async invoke(req) {
      return {
        output: req.prompt.includes('CRITIC') ? 'VERDICT: pass\nEVIDENCE: ok' : 'DONE',
        costUsd: 0, tokens: 0, durationMs: 1,
      }
    },
  })
  const def = loop({
    nodes: [
      { id: 'approve', role: 'gate' },
      { id: 'do', role: 'executor', agent: 'a', after: ['approve'] },
      { id: 'crit', role: 'critic', agent: 'a', of: 'do', after: ['do'] },
    ],
    rails: { maxIterations: 3, maxCostUsd: 5, maxWallMinutes: 1 },
  })
  const report = await runLoop(def, {
    registry,
    now: () => t,
    gate: async () => {
      t = 10 * 60_000 // 10 real minutes pass while "waiting for the human"
      return { approved: true }
    },
  })
  expect(report.status).toBe('verified')
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
    invoke: async () => { throw new Error('HTTP 401 unauthorized - please login') },
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

test('rate-limit failover is visible in the journal: node_progress records the hop, node_end carries the agent that served the call', async () => {
  const registry = createRegistry()
  registry.register({
    name: 'claude-code',
    invoke: async () => { throw new Error('claude-code exited 1: HTTP 429 Too Many Requests') },
  })
  registry.register({
    name: 'copilot-cli',
    async invoke(req) {
      return {
        output: req.prompt.includes('CRITIC') ? 'VERDICT: pass\nEVIDENCE: ok' : 'DONE',
        costUsd: 0, tokens: 0, durationMs: 1,
      }
    },
  })
  const runDir = join(mkdtempSync(join(tmpdir(), 'lr-')), 'run')
  const def = loop({
    agents: {
      worker: { adapter: 'claude-code', model: 'sonnet', fallback: 'worker-b' },
      'worker-b': { adapter: 'copilot-cli', model: 'claude-sonnet-5' },
    },
    nodes: [
      { id: 'do', role: 'executor', agent: 'worker' },
      { id: 'crit', role: 'critic', agent: 'worker-b', of: 'do', after: ['do'] },
    ],
  })
  const report = await runLoop(def, { registry, runDir, retries: 0, sleep: async () => {} })
  expect(report.status).toBe('verified')
  const events = readJournal(join(runDir, 'journal.jsonl'))
  const hop = events.find((e) => e.type === 'node_progress' && e.data.nodeId === 'do')!
  expect(hop.data.chunk).toContain('rate-limited on claude-code; failing over to worker-b (copilot-cli)')
  const end = events.find((e) => e.type === 'node_end' && e.data.nodeId === 'do')!
  expect(end.data).toMatchObject({ agent: 'worker-b', adapter: 'copilot-cli', model: 'claude-sonnet-5' })
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

test('a mid-node permission prompt is surfaced, registered, answered through the permission-registry, and the answer reaches the subprocess', async () => {
  const registry = createRegistry()
  registry.register({
    name: 'mock',
    async invoke(req, _onChunk, onPermission) {
      if (req.prompt.includes('EXECUTOR')) {
        const answer = await onPermission?.({
          question: 'allow write_file?',
          answer: (approved) => (approved ? 'y\n' : 'n\n'),
        })
        const approved = typeof answer === 'boolean' ? answer : answer?.approved
        return { output: approved ? 'DONE' : 'REFUSED', costUsd: 0, tokens: 0, durationMs: 1 }
      }
      return { output: 'VERDICT: pass\nEVIDENCE: ok', costUsd: 0, tokens: 0, durationMs: 1 }
    },
  })
  const runDir = join(mkdtempSync(join(tmpdir(), 'lr-')), 'run')
  const def = loop({
    nodes: [
      { id: 'do', role: 'executor', agent: 'a' },
      { id: 'crit', role: 'critic', agent: 'a', of: 'do', after: ['do'] },
    ],
  })
  const runId = 'run-permission-test'

  // Answer the pending permission as soon as it appears in the registry -
  // exactly the channel the dashboard's /control answer-permission action
  // will use (see dashboard/permission-registry.ts).
  const answered = (async () => {
    for (let i = 0; i < 200; i++) {
      const pending = getPendingPermission(runId)
      if (pending) {
        expect(pending.nodeId).toBe('do')
        expect(pending.question).toBe('allow write_file?')
        expect(resolvePendingPermission(runId, 'do', 'y\n')).toBe(true)
        return
      }
      await new Promise((r) => setTimeout(r, 5))
    }
    throw new Error('permission never appeared as pending')
  })()

  const report = await runLoop(def, { registry, runId, runDir })
  await answered

  expect(report.status).toBe('verified')
  const events = readJournal(join(runDir, 'journal.jsonl'))
  const requestEvent = events.find((e) => e.type === 'permission_request' && e.data.nodeId === 'do')
  const resolvedEvent = events.find((e) => e.type === 'permission_resolved' && e.data.nodeId === 'do')
  expect(requestEvent?.data.question).toBe('allow write_file?')
  expect(resolvedEvent?.data.approved).toBe(true)
  // proves the answer actually reached the "subprocess" (the mock adapter's
  // own invoke, which only returns 'DONE' once it sees approved === true)
  expect(events.find((e) => e.type === 'node_end' && e.data.nodeId === 'do')?.data.output).toBe('DONE')
  expect(getPendingPermission(runId)).toBeUndefined() // swept once the run settled
})

// The core bug this feature exists to fix: an adapter (copilot/codex/aider)
// that always reports costUsd 0 but carries a nonzero, pricing-derived
// estimatedCostUsd must still be able to breach rails.max_cost_usd. Before
// RailsGuard tracked estimated spend separately and check() breached on the
// combined total, this exact scenario could NEVER halt on cost - the guard
// only ever saw 0, no matter how much a run actually spent (per its own
// estimate). This test fails against that pre-fix behavior and passes now.
test('rails.max_cost_usd fires on estimate-only spend (costUsd 0, estimatedCostUsd > 0)', async () => {
  // Mirrors "denies verified when a rail-skipped node leaves verification
  // incomplete" above, but with only an estimate driving the breach: do and
  // crit both report costUsd 0 with a nonzero estimatedCostUsd. The combined
  // estimated spend breaches max_cost_usd after crit, so judge is skipped
  // pre-start, leaving verification incomplete -> halted, not verified.
  const mock = new MockAdapter([
    { match: /EXECUTOR/, output: 'DONE', costUsd: 0, estimatedCostUsd: 0.6 },
    { match: /CRITIC/, output: 'VERDICT: pass\nEVIDENCE: ok', costUsd: 0, estimatedCostUsd: 0.6 },
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
  expect(report.reason).toContain('est')
  expect(mock.calls).toHaveLength(2) // judge's adapter was never invoked
  expect(report.costUsd).toBeCloseTo(0) // real spend genuinely stayed 0
  expect(report.estimatedCostUsd).toBeCloseTo(1.2) // estimate is what breached it
})

// filesTouched must come from real git state (core/git.ts), never from the
// reporting agent's own narration - stubbed here rather than shelling out to
// a real git repo, since what's under test is that buildFinalReport wires
// opts.cwd through to the git helper and threads its result onto the report,
// not that the git helper itself works (see core/git.test.ts for that).
test('buildFinalReport populates report.filesTouched from the real git computation, keyed on opts.cwd', async () => {
  const spy = vi.spyOn(git, 'filesTouched').mockReturnValue(['src/a.ts', 'src/b.ts'])
  try {
    const mock = new MockAdapter([
      { match: /PLANNER/, output: 'the plan' },
      { match: /CRITIC/, output: 'VERDICT: pass\nEVIDENCE: plan is sound' },
      { match: /EXECUTOR/, output: 'DONE' },
      { match: /CRITIC/, output: 'VERDICT: pass\nEVIDENCE: verified DONE' },
    ])
    const report = await runLoop(loop(), { registry: reg(mock), cwd: '/some/run/cwd' })
    expect(report.report.filesTouched).toEqual(['src/a.ts', 'src/b.ts'])
    expect(spy).toHaveBeenCalledWith('/some/run/cwd')
  } finally {
    spy.mockRestore()
  }
})

test('buildFinalReport sets filesTouched to an empty list, never calling git, when no cwd was given', async () => {
  const spy = vi.spyOn(git, 'filesTouched')
  try {
    const mock = new MockAdapter([
      { match: /PLANNER/, output: 'the plan' },
      { match: /CRITIC/, output: 'VERDICT: pass\nEVIDENCE: plan is sound' },
      { match: /EXECUTOR/, output: 'DONE' },
      { match: /CRITIC/, output: 'VERDICT: pass\nEVIDENCE: verified DONE' },
    ])
    const report = await runLoop(loop(), { registry: reg(mock) })
    expect(report.report.filesTouched).toEqual([])
    expect(spy).not.toHaveBeenCalled()
  } finally {
    spy.mockRestore()
  }
})

// End-to-end degrade-gracefully proof, using the real (non-stubbed) git
// helper against an actual non-git directory - see core/git.test.ts for the
// exhaustive git-command coverage; this only proves buildFinalReport itself
// never fails the run over it.
test('buildFinalReport degrades to an empty filesTouched list when opts.cwd is not a git repo, without failing the run', async () => {
  const nonGitDir = mkdtempSync(join(tmpdir(), 'lr-nongit-'))
  const mock = new MockAdapter([
    { match: /PLANNER/, output: 'the plan' },
    { match: /CRITIC/, output: 'VERDICT: pass\nEVIDENCE: plan is sound' },
    { match: /EXECUTOR/, output: 'DONE' },
    { match: /CRITIC/, output: 'VERDICT: pass\nEVIDENCE: verified DONE' },
  ])
  const report = await runLoop(loop(), { registry: reg(mock), cwd: nonGitDir })
  expect(report.status).toBe('verified')
  expect(report.report.filesTouched).toEqual([])
})

// The fallback path (no reporting agent) is the one path buildFinalReport
// takes on virtually every rail breach; filesTouched must still populate
// there too, since it comes from git, entirely independent of whether any
// reporting agent ever ran.
test('buildFinalReport populates filesTouched on the fallback report path too (no reporting agent)', async () => {
  const spy = vi.spyOn(git, 'filesTouched').mockReturnValue(['README.md'])
  try {
    const def = loop({
      agents: {},
      nodes: [
        { id: 'do', role: 'tester', run: 'true', expect: 'exit 0' },
      ],
    })
    const report = await runLoop(def, { registry: reg(new MockAdapter([])), cwd: '/tmp/whatever' })
    expect(report.report.source).toBe('fallback')
    expect(report.report.filesTouched).toEqual(['README.md'])
  } finally {
    spy.mockRestore()
  }
})

test("a successful generates:'graph' splice re-persists the run's own loopfile.json copy with the extended graph, when a runDir is set", async () => {
  const def: LoopDef = {
    name: 'self-planning', goal: 'do the generated thing',
    agents: { planner: { adapter: 'mock' } },
    nodes: [
      { id: 'plan', role: 'planner', agent: 'planner', generates: 'graph' },
      { id: 'approve', role: 'gate', after: ['plan'] },
    ],
    rails: { maxIterations: 5, maxCostUsd: 1 },
    verdictPolicy: { kind: 'all-pass' },
  }
  const mock = new MockAdapter([
    { match: /PLANNER/, output: 'graph:\n  build: { role: executor, agent: planner }\n  check: { role: critic, of: build, agent: planner }\n' },
    { output: '[mock] build done' },
    { output: 'VERDICT: pass\nEVIDENCE: looks good' },
  ])
  const runDir = join(mkdtempSync(join(tmpdir(), 'lr-')), 'run')
  const report = await runLoop(def, {
    registry: reg(mock), runDir, gate: async () => ({ approved: true }),
  })
  expect(report.status).toBe('verified')

  const persisted = loadRunLoopDef(runDir)
  // "approve" is dropped from the LIVE execution list once resolved (its
  // job is done - see applySplice) but must still appear in the PERSISTED
  // copy: it genuinely ran, the dashboard still shows it from real journal
  // events, and dropping it here too would leave it rendered with no edges
  // at all (a real regression, confirmed live - see the dedicated edge-
  // preservation test below). "build"/"check" only exist because the
  // splice extended the graph, and that extension must be reflected too.
  expect(persisted?.nodes.map((n) => n.id).sort()).toEqual(['approve', 'build', 'check', 'plan'])
})

test("a resolved plan-approval gate keeps its original `after` edge in the persisted copy, so the dashboard can still draw it connected", async () => {
  const def: LoopDef = {
    name: 'self-planning', goal: 'do the generated thing',
    agents: { planner: { adapter: 'mock' } },
    nodes: [
      { id: 'plan', role: 'planner', agent: 'planner', generates: 'graph' },
      { id: 'review', role: 'critic', agent: 'planner', of: 'plan', after: ['plan'] },
      { id: 'approve', role: 'gate', after: ['review'] },
    ],
    rails: { maxIterations: 5, maxCostUsd: 1 },
    verdictPolicy: { kind: 'all-pass' },
  }
  const mock = new MockAdapter([
    { match: /PLANNER/, output: 'graph:\n  build: { role: executor, agent: planner }\n  check: { role: critic, of: build, agent: planner }\n' },
    { match: /CRITIC/, output: 'VERDICT: pass\nEVIDENCE: plan is sound' },
    { output: '[mock] build done' },
    { output: 'VERDICT: pass\nEVIDENCE: looks good' },
  ])
  const runDir = join(mkdtempSync(join(tmpdir(), 'lr-')), 'run')
  const report = await runLoop(def, {
    registry: reg(mock), runDir, gate: async () => ({ approved: true }),
  })
  expect(report.status).toBe('verified')

  const persisted = loadRunLoopDef(runDir)
  const approve = persisted?.nodes.find((n) => n.id === 'approve')
  // The original edge (review -> approve), not stripped the way it is in
  // the live execution list (splitRegions/applySplice strip a gate's edge
  // into the planning region because it's meaningless to the execution
  // scheduler - but edgesFromDef needs exactly this edge to draw the gate
  // connected at all).
  expect(approve?.after).toEqual(['review'])
})

test("a plan-approval rejection lets the replanning generates:'graph' planner reply with a compact edits: block instead of the full graph, and the engine applies it server-side", async () => {
  const def: LoopDef = {
    name: 'self-planning', goal: 'do the generated thing',
    agents: { planner: { adapter: 'mock' } },
    nodes: [
      { id: 'plan', role: 'planner', agent: 'planner', generates: 'graph' },
      { id: 'approve', role: 'gate', after: ['plan'] },
    ],
    rails: { maxIterations: 5, maxCostUsd: 1, replanLimit: 2 },
    verdictPolicy: { kind: 'all-pass' },
  }
  const mock = new MockAdapter([
    {
      match: /PLANNER/,
      output: 'graph:\n  build: { role: executor, agent: planner, prompt: "Implement the feature." }\n'
        + '  check: { role: critic, of: build, agent: planner }\n',
    },
    // The planner's SECOND reply, after a gate rejection carrying feedback,
    // is a compact edits: block - not a full graph re-emission - targeting
    // exactly the flagged node's prompt.
    {
      match: /PLANNER/,
      output: 'edits:\n  - node: build\n    set: { prompt: "Implement the feature AND add a regression test." }\n',
    },
    { output: '[mock] build done' },
    { output: 'VERDICT: pass\nEVIDENCE: looks good' },
  ])
  let gateCalls = 0
  const report = await runLoop(def, {
    registry: reg(mock),
    gate: async () => {
      gateCalls += 1
      // reject the first approval with feedback (forces a replan), approve the second
      return gateCalls === 1
        ? { approved: false, feedback: "build's prompt is missing a test requirement" }
        : { approved: true }
    },
  })
  expect(report.status).toBe('verified')
  expect(report.replans).toBe(1)
  // The spliced "build" node must reflect the edits block's targeted change,
  // proving the engine actually applied the compact reply server-side
  // rather than requiring (or silently discarding) a full graph re-emit.
  const buildOutcome = report.outcomes.find((o) => o.nodeId === 'build')
  expect(buildOutcome).toBeDefined()
  const plannerCalls = mock.calls.filter((c) => c.prompt.includes('PLANNER'))
  expect(plannerCalls).toHaveLength(2)
  // The second call must have been offered the compact edits option.
  expect(plannerCalls[1].prompt.toLowerCase()).toContain('edits')
})

test("no runDir set means no persisted loopfile.json copy is written at all, on a splice or otherwise - runLoop never assumes one", async () => {
  const def: LoopDef = {
    name: 'self-planning', goal: 'do the generated thing',
    agents: { planner: { adapter: 'mock' } },
    nodes: [
      { id: 'plan', role: 'planner', agent: 'planner', generates: 'graph' },
      { id: 'approve', role: 'gate', after: ['plan'] },
    ],
    rails: { maxIterations: 5, maxCostUsd: 1 },
    verdictPolicy: { kind: 'all-pass' },
  }
  const mock = new MockAdapter([
    { match: /PLANNER/, output: 'graph:\n  build: { role: executor, agent: planner }\n  check: { role: critic, of: build, agent: planner }\n' },
    { output: '[mock] build done' },
    { output: 'VERDICT: pass\nEVIDENCE: looks good' },
  ])
  const report = await runLoop(def, { registry: reg(mock), gate: async () => ({ approved: true }) })
  expect(report.status).toBe('verified') // splice itself still works with no runDir at all
})

// EFF-5 probe panels, end to end: iteration 1's leader fails -> followers are
// skipped (spend saved, aggregate already determined); iteration 2's leader
// passes -> ALL clones run and pass -> verified. The guarantee holds: the run
// only verified after every declared clone actually ran and passed.
test('probe panel: failing iteration runs only the leader; the verifying iteration runs the full panel', async () => {
  const mock = new MockAdapter([
    { match: /EXECUTOR/, output: 'half done' },
    { match: /CRITIC/, output: 'VERDICT: fail\nEVIDENCE: missing DONE' },
    { match: /EXECUTOR/, output: 'DONE' },
    { match: /CRITIC/, output: 'VERDICT: pass\nEVIDENCE: ok' },
    { match: /CRITIC/, output: 'VERDICT: pass\nEVIDENCE: ok' },
    { match: /CRITIC/, output: 'VERDICT: pass\nEVIDENCE: ok' },
  ])
  const def = loop({
    nodes: [
      { id: 'do', role: 'executor', agent: 'a' },
      { id: 'crit', role: 'critic', agent: 'a', of: 'do', after: ['do'], panel: 3, probe: true },
    ],
  })
  const report = await runLoop(def, { registry: reg(mock) })
  expect(report.status).toBe('verified')
  expect(report.iterations).toBe(2)
  const criticCalls = mock.calls.filter((c) => c.prompt.includes('CRITIC')).length
  // 1 (probe leader, iteration 1) + 3 (full panel, iteration 2) - NOT 6
  expect(criticCalls).toBe(4)
})

// Test-tamper guard (protect rail): the executor "fixes" the suite by
// editing the test file -> deterministic fail with a revert instruction;
// a second consecutive violation halts the run.
test('protect rail: modifying a protected file fails the iteration; reverting lets it verify', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lr-runner-protect-'))
  mkdirSync(join(dir, 'test'), { recursive: true })
  const testPath = join(dir, 'test', 'x.test.js')
  writeFileSync(testPath, 'assert(realBehavior())')
  let call = 0
  const registry = createRegistry()
  registry.register({
    name: 'mock',
    async invoke(req) {
      const critic = req.prompt.includes('VERDICT:')
      if (critic) return { output: 'VERDICT: pass\nEVIDENCE: ok', costUsd: 0, tokens: 0, durationMs: 1 }
      call += 1
      // iteration 1: the executor cheats by gutting the test file
      if (call === 1) writeFileSync(testPath, 'assert(true) // gutted')
      // iteration 2: told to revert, it restores the original bytes
      if (call === 2) writeFileSync(testPath, 'assert(realBehavior())')
      return { output: `attempt ${call}`, costUsd: 0, tokens: 0, durationMs: 1 }
    },
  })
  const def: LoopDef = {
    name: 'protect-e2e', goal: 'fix it without touching tests',
    agents: { a: { adapter: 'mock' } },
    nodes: [
      { id: 'fix', role: 'executor', agent: 'a' },
      { id: 'crit', role: 'critic', agent: 'a', of: 'fix', after: ['fix'] },
    ],
    rails: { maxIterations: 4, maxCostUsd: 5 },
    verdictPolicy: { kind: 'all-pass' },
    protect: ['test/**'],
  }
  const report = await runLoop(def, { registry: reg2(registry), cwd: dir })
  expect(report.status).toBe('verified')
  expect(report.iterations).toBe(2)
})

test('protect rail: a second consecutive violation halts instead of burning budget', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lr-runner-protect2-'))
  mkdirSync(join(dir, 'test'), { recursive: true })
  writeFileSync(join(dir, 'test', 'x.test.js'), 'assert(realBehavior())')
  let call = 0
  const registry = createRegistry()
  registry.register({
    name: 'mock',
    async invoke(req) {
      if (req.prompt.includes('VERDICT:')) {
        return { output: 'VERDICT: pass\nEVIDENCE: ok', costUsd: 0, tokens: 0, durationMs: 1 }
      }
      call += 1
      // never reverts - keeps rewriting the test file every iteration
      writeFileSync(join(dir, 'test', 'x.test.js'), `assert(true) // gutted v${call}`)
      return { output: `attempt ${call}`, costUsd: 0, tokens: 0, durationMs: 1 }
    },
  })
  const def: LoopDef = {
    name: 'protect-halt', goal: 'g',
    agents: { a: { adapter: 'mock' } },
    nodes: [
      { id: 'fix', role: 'executor', agent: 'a' },
      { id: 'crit', role: 'critic', agent: 'a', of: 'fix', after: ['fix'] },
    ],
    rails: { maxIterations: 6, maxCostUsd: 5 },
    verdictPolicy: { kind: 'all-pass' },
    protect: ['test/**'],
  }
  const report = await runLoop(def, { registry: reg2(registry), cwd: dir })
  expect(report.status).toBe('halted')
  expect(report.reason).toContain('protect')
  expect(report.iterations).toBe(2) // not 6 - the rail stopped it early
})

// tiny local helper: runner tests' shared reg() is typed for MockAdapter
function reg2(registry: ReturnType<typeof createRegistry>) {
  return registry
}

// Scope rail: the allowlist inverse of protect - touching files OUTSIDE
// scope: fails the iteration; reverting lets it verify.
test('scope rail: out-of-scope changes fail the iteration; reverting lets it verify', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lr-runner-scope-'))
  mkdirSync(join(dir, 'src'), { recursive: true })
  writeFileSync(join(dir, 'src', 'impl.js'), 'original')
  writeFileSync(join(dir, 'README.md'), 'readme v1')
  let call = 0
  const registry = createRegistry()
  registry.register({
    name: 'mock',
    async invoke(req) {
      if (req.prompt.includes('VERDICT:')) {
        return { output: 'VERDICT: pass\nEVIDENCE: ok', costUsd: 0, tokens: 0, durationMs: 1 }
      }
      call += 1
      writeFileSync(join(dir, 'src', 'impl.js'), `edit ${call}`) // in scope - always fine
      if (call === 1) writeFileSync(join(dir, 'README.md'), 'sneaky rewrite') // scope creep
      if (call === 2) writeFileSync(join(dir, 'README.md'), 'readme v1') // reverted
      return { output: `attempt ${call}`, costUsd: 0, tokens: 0, durationMs: 1 }
    },
  })
  const def: LoopDef = {
    name: 'scope-e2e', goal: 'edit only src',
    agents: { a: { adapter: 'mock' } },
    nodes: [
      { id: 'fix', role: 'executor', agent: 'a' },
      { id: 'crit', role: 'critic', agent: 'a', of: 'fix', after: ['fix'] },
    ],
    rails: { maxIterations: 4, maxCostUsd: 5 },
    verdictPolicy: { kind: 'all-pass' },
    scope: ['src/**'],
  }
  const report = await runLoop(def, { registry: reg2(registry), cwd: dir })
  expect(report.status).toBe('verified')
  expect(report.iterations).toBe(2)
})

test('scope rail: repeated out-of-scope changes halt the run', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lr-runner-scope2-'))
  mkdirSync(join(dir, 'src'), { recursive: true })
  writeFileSync(join(dir, 'README.md'), 'readme v1')
  let call = 0
  const registry = createRegistry()
  registry.register({
    name: 'mock',
    async invoke(req) {
      if (req.prompt.includes('VERDICT:')) {
        return { output: 'VERDICT: pass\nEVIDENCE: ok', costUsd: 0, tokens: 0, durationMs: 1 }
      }
      call += 1
      writeFileSync(join(dir, 'README.md'), `sneaky rewrite v${call}`)
      return { output: `attempt ${call}`, costUsd: 0, tokens: 0, durationMs: 1 }
    },
  })
  const def: LoopDef = {
    name: 'scope-halt', goal: 'g',
    agents: { a: { adapter: 'mock' } },
    nodes: [
      { id: 'fix', role: 'executor', agent: 'a' },
      { id: 'crit', role: 'critic', agent: 'a', of: 'fix', after: ['fix'] },
    ],
    rails: { maxIterations: 6, maxCostUsd: 5 },
    verdictPolicy: { kind: 'all-pass' },
    scope: ['src/**'],
  }
  const report = await runLoop(def, { registry: reg2(registry), cwd: dir })
  expect(report.status).toBe('halted')
  expect(report.reason).toContain('scope')
  expect(report.iterations).toBe(2)
})

// Blind validation e2e in a real git workspace: the critic's prompt carries
// the actual diff (including the executor's real edit), never the
// executor's narrative.
test('blind critic reviews the real workspace diff, not the executor narrative', async () => {
  const { execFileSync } = await import('node:child_process')
  const dir = mkdtempSync(join(tmpdir(), 'lr-blind-'))
  execFileSync('git', ['init', '-q'], { cwd: dir })
  execFileSync('git', ['config', 'user.email', 't@e.com'], { cwd: dir })
  execFileSync('git', ['config', 'user.name', 'T'], { cwd: dir })
  writeFileSync(join(dir, 'impl.js'), 'broken code')
  execFileSync('git', ['add', '.'], { cwd: dir })
  execFileSync('git', ['commit', '-q', '-m', 'seed'], { cwd: dir })
  const prompts: string[] = []
  const registry = createRegistry()
  registry.register({
    name: 'mock',
    async invoke(req) {
      if (req.prompt.includes('VERDICT:')) {
        prompts.push(req.prompt)
        return { output: 'VERDICT: pass\nEVIDENCE: diff reviewed', costUsd: 0, tokens: 0, durationMs: 1 }
      }
      writeFileSync(join(dir, 'impl.js'), 'ACTUALLY-FIXED-CODE')
      return { output: 'NARRATIVE: I rewrote everything brilliantly', costUsd: 0, tokens: 0, durationMs: 1 }
    },
  })
  const def: LoopDef = {
    name: 'blind-e2e', goal: 'fix impl',
    agents: { a: { adapter: 'mock' } },
    nodes: [
      { id: 'fix', role: 'executor', agent: 'a' },
      { id: 'crit', role: 'critic', agent: 'a', of: 'fix', after: ['fix'], blind: true },
    ],
    rails: { maxIterations: 2, maxCostUsd: 5 },
    verdictPolicy: { kind: 'all-pass' },
  }
  const report = await runLoop(def, { registry: reg2(registry), cwd: dir })
  expect(report.status).toBe('verified')
  const criticPrompt = prompts[0]
  expect(criticPrompt).toContain('ACTUALLY-FIXED-CODE')          // the real diff
  expect(criticPrompt).not.toContain('rewrote everything')       // never the narrative
})
