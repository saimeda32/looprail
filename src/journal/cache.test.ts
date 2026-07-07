import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { loadCache } from './cache.js'
import { readJournal } from './journal.js'
import { reconstructRunState } from './runs.js'
import { runLoop } from '../engine/runner.js'
import { MockAdapter } from '../adapters/mock.js'
import { createRegistry } from '../adapters/registry.js'
import type { Adapter, LoopDef } from '../core/types.js'

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

// This test used to assert loadCache's OLD `excludeIteration: 2` dropped
// BOTH `do` and `crit` from iteration 2 wholesale, just because they shared
// an iteration number with the node whose feedback was being replayed. That
// whole-iteration exclusion is exactly the needless-rework bug this change
// fixes: `do`'s iteration-2 node_end had nothing to do with why `crit`'s
// evidence was reconstructed as feedback, so it never needed to be dropped.
// The precise contract (`excludeNodes`) now excludes ONLY the exact
// (nodeId, iteration) pairs named as sources - see cache.test.ts's new
// 'loadCache with excludeNodes' tests below for the (a)/(b) proof, and
// runs.test.ts for how reconstructRunState computes those sources.
test('loadCache with excludeNodes drops only the named (nodeId, iteration) pairs, not every outcome at that iteration', async () => {
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
  // Exclude ONLY `crit`'s iteration-2 node_end (the reconstruction source -
  // its evidence is what would become the replayed feedback), not `do`'s.
  const precise = loadCache(join(runDir, 'journal.jsonl'), { excludeNodes: [{ nodeId: 'crit', iteration: 2 }] })
  expect(precise.size).toBe(fullCache.size - 1) // only crit's iteration-2 entry dropped
  for (const [hash, outcome] of fullCache) {
    if (outcome.output === 'attempt 1') expect(precise.get(hash)).toEqual(outcome) // iteration 1, untouched
    if (outcome.output === 'attempt 2') expect(precise.get(hash)).toEqual(outcome) // do's iteration 2, PRECISION WIN: retained
  }
  const excludedHash = [...fullCache].find(([, o]) => o.output === 'VERDICT: fail\nEVIDENCE: still no')?.[0]
  expect(excludedHash).toBeDefined()
  expect(precise.get(excludedHash!)).toBeUndefined() // crit's iteration 2 entry: PROTECTION HOLDS, excluded
})

// PROTECTION HOLDS, provably, at the loadCache/runLoop layer directly (see
// cli/resume-cmd.test.ts for the same proof at the resumeAction layer): a
// plateaued run - `do` always emits the same output regardless of feedback,
// `crit` always fails with the same evidence text - makes iteration 2's own
// `crit` node_end contextHash come out byte-for-byte identical to what a
// resumed "iteration 3" independently reconstructs (same feedback text,
// derived from iteration 2's evidence, is exactly iteration 1's evidence
// text; same deterministic `do` output). This is a REAL collision, not a
// hypothetical one: the two assertions below flip on it (a bare
// loadCache(journalPath) with no exclusion DOES serve `crit`'s stale fail
// verdict from cache with zero adapter calls; loadCache with
// `excludeNodes: sources` forces a genuine adapter call instead), proving
// the fix's exclusion mechanism is what's under test, not incidental prompt
// differences.
const stuckLoop: LoopDef = {
  name: 'stuck', goal: 'g',
  agents: { a: { adapter: 'mock' } },
  nodes: [
    { id: 'do', role: 'executor', agent: 'a' },
    { id: 'crit', role: 'critic', agent: 'a', of: 'do', after: ['do'] },
  ],
  rails: { maxIterations: 2, maxCostUsd: 5 },
  verdictPolicy: { kind: 'all-pass' },
}
const stableAdapter = (): Adapter => ({
  name: 'mock',
  invoke: async (req) => (/CRITIC/.test(req.prompt)
    ? { output: 'VERDICT: fail\nEVIDENCE: still no', costUsd: 0.1, tokens: 0, durationMs: 1 }
    : { output: 'SAME', costUsd: 0.1, tokens: 0, durationMs: 1 }),
})

test('a stale, plateaued node_end IS served from cache with no exclusion, but IS NOT once its (nodeId, iteration) is excluded - a real collision, not just a filtering check', async () => {
  const runDir = join(mkdtempSync(join(tmpdir(), 'lr-')), 'run')
  const registry = createRegistry()
  registry.register(stableAdapter())
  const first = await runLoop(stuckLoop, { registry, runDir })
  expect(first.status).toBe('halted') // still failing "still no" after both iterations

  const journalPath = join(runDir, 'journal.jsonl')
  const events = readJournal(journalPath)
  const { plan, feedback, sources, priorOutputs } = reconstructRunState(events)
  expect(feedback).toBe('[crit] still no')
  expect(sources).toEqual([{ nodeId: 'crit', iteration: 2 }])

  const priorIterations = first.iterations // 2
  // Bump maxIterations for the resumed continuation, exactly as
  // resume-cmd.ts's `--max-iterations` override does - the point here is
  // whether iteration 3 is served from cache, not whether the rail allows
  // it to run at all.
  const resumedLoop: LoopDef = { ...stuckLoop, rails: { ...stuckLoop.rails, maxIterations: 5 } }

  // No exclusion at all: a throwing adapter proves the resumed "iteration
  // 3" round is served ENTIRELY from cache - including crit's stale fail -
  // without a single real adapter call.
  const throwingRegistry = createRegistry()
  throwingRegistry.register({ name: 'mock', invoke: async () => { throw new Error('must not be called') } })
  const fullCache = loadCache(journalPath)
  const replayed = await runLoop(resumedLoop, {
    registry: throwingRegistry,
    cache: fullCache,
    startIteration: priorIterations,
    initialPlan: plan,
    initialFeedback: feedback,
    initialPriorOutputs: priorOutputs,
    skipPlanning: true,
  })
  expect(replayed.status).toBe('halted') // stale "still no" replayed forever, never a fresh chance
  expect(replayed.costUsd).toBe(0) // proof: not one real adapter call happened

  // With the precise exclusion, crit MUST be genuinely re-invoked.
  const preciseCache = loadCache(journalPath, { excludeNodes: sources })
  const calls: string[] = []
  const freshRegistry = createRegistry()
  freshRegistry.register({
    name: 'mock',
    invoke: async (req) => {
      calls.push(req.prompt)
      return /CRITIC/.test(req.prompt)
        ? { output: 'VERDICT: pass\nEVIDENCE: fresh look, actually fine', costUsd: 0.1, tokens: 0, durationMs: 1 }
        : { output: 'SAME', costUsd: 0.1, tokens: 0, durationMs: 1 }
    },
  })
  const resumed = await runLoop(resumedLoop, {
    registry: freshRegistry,
    cache: preciseCache,
    startIteration: priorIterations,
    initialPlan: plan,
    initialFeedback: feedback,
    initialPriorOutputs: priorOutputs,
    skipPlanning: true,
  })
  expect(resumed.status).toBe('verified') // crit really re-evaluated, genuinely passed this time
  expect(calls.some((p) => /CRITIC/.test(p))).toBe(true) // crit made a real call, not a cache hit
  expect(calls.some((p) => /EXECUTOR/.test(p))).toBe(false) // do's own iteration-2 entry legitimately reused
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
