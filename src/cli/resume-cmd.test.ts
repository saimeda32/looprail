import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
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

// Reproduces the real-world case this change fixes: a wall/cost rail cuts
// an iteration off midway, after several independent node pairs have
// already fully run and PASSED their own review - so reconstructRunState
// finds no failing verdict at all (feedback stays null) and no planner ran
// this iteration either (sources: []). Under the OLD `excludeIteration`
// behavior, resume would still needlessly drop and re-run every one of
// those already-passed nodes' cache entries purely for sharing the halted
// iteration's number - spending real adapter calls on work that had
// nothing to do with the halt. The fix must serve them from cache instead.
const PRECISION_FIXTURE = `
name: resume-precision-fixture
goal: Build three independent parts.
agents:
  worker:  { adapter: mock }
  checker: { adapter: mock }
graph:
  doA:   { role: executor, agent: worker, prompt: "Build A." }
  critA: { role: critic, agent: checker, of: doA, after: doA, prompt: "Review A." }
  doB:   { role: executor, agent: worker, prompt: "Build B." }
  critB: { role: critic, agent: checker, of: doB, after: doB, prompt: "Review B." }
  doC:   { role: executor, agent: worker, prompt: "Build C.", after: [critA, critB] }
  critC: { role: critic, agent: checker, of: doC, after: doC, prompt: "Review C." }
rails:
  max_iterations: 3
  max_cost_usd: 0.75
`

async function haltedPrecisionRun(): Promise<{ cwd: string; runId: string }> {
  const cwd = mkdtempSync(join(tmpdir(), 'lr-resume-precision-'))
  writeFileSync(join(cwd, 'looprail.yaml'), PRECISION_FIXTURE)
  const registry = createRegistry()
  registry.register(new MockAdapter([
    // doA/critA and doB/critB run and pass (layers 0 and 1) before doC
    // (layer 2, gated behind [critA, critB]) is pre-start-checked and
    // skipped for breaching max_cost_usd (0.3+0.1+0.3+0.1 = 0.8 > 0.75).
    // No steps exist for "Build C."/"Review C." here - if the scheduler
    // ever let doC/critC run in this first pass, MockAdapter would throw
    // "exhausted", proving they really were skipped, not silently run.
    { match: /Build A\./, output: 'A done', costUsd: 0.3 },
    { match: /Review A\./, output: 'VERDICT: pass\nEVIDENCE: A ok', costUsd: 0.1 },
    { match: /Build B\./, output: 'B done', costUsd: 0.3 },
    { match: /Review B\./, output: 'VERDICT: pass\nEVIDENCE: B ok', costUsd: 0.1 },
  ]))
  const { io, lines } = capture()
  const code = await runAction(undefined, { cwd, json: true }, { io, registry })
  expect(code).toBe(2) // halted: cost rail breached mid-iteration, doC/critC skipped
  const runId = (JSON.parse(lines.at(-1)!) as { runId: string }).runId
  return { cwd, runId }
}

test('resume reuses already-passed independent nodes\' cache entries from the same halted iteration, instead of needlessly re-running them', async () => {
  const { cwd, runId } = await haltedPrecisionRun()
  // Generous timeout: under the OLD whole-iteration-exclusion behavior this
  // test doesn't just fail an assertion - it drives real invokeWithRetry
  // backoff (1s+4s per exhausted call, repeated across every needlessly
  // re-run node/iteration) before finally failing. That slow, wasteful
  // retry churn IS the inefficiency being fixed, so it's allowed to play
  // out here rather than being masked by the short default test timeout.
  const registry = createRegistry()
  // Deliberately NO steps for "Build A./B."/"Review A./B." - reaching the
  // adapter for any of them would throw "exhausted", failing the test.
  // Only doC/critC (never run before - genuinely new work) get scripted.
  const mock = new MockAdapter([
    { match: /Build C\./, output: 'C done', costUsd: 0.1 },
    { match: /Review C\./, output: 'VERDICT: pass\nEVIDENCE: C ok', costUsd: 0.1 },
  ])
  registry.register(mock)
  const code = await resumeAction(runId, { cwd, json: true, maxCostUsd: 5 }, { io: capture().io, registry })
  expect(code).toBe(0)
  // 3 calls, not 2: doC + critC (the real work) plus the run's own final
  // report narration call (buildFinalReport in runner.ts - always a fresh
  // call once a run verifies/halts, entirely unrelated to node caching).
  expect(mock.calls).toHaveLength(3)
  expect(mock.calls.map((c) => c.prompt).some((p) => /Build C\./.test(p))).toBe(true)
  expect(mock.calls.map((c) => c.prompt).some((p) => /Review C\./.test(p))).toBe(true)
}, 60000)

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

// PROTECTION HOLDS, provably: a run that plateaus on the SAME critic
// evidence for two full iterations in a row builds up a genuine contextHash
// collision, not just a plausible-looking one. Once `do`'s deterministic
// output and `crit`'s evidence text are both stable across iterations 1 and
// 2, iteration 2's own `crit` prompt (goal + feedback reconstructed from
// iteration 1's evidence + "work under review: do's output") is BYTE-FOR-
// BYTE IDENTICAL to what the resumed iteration 3 would independently build
// (feedback reconstructed from iteration 2's evidence - the same text - and
// the same deterministic `do` output). So `crit`'s own iteration-2 node_end
// really is a live cache-hit candidate for resume's first new iteration -
// this isn't merely asserting the exclusion list looks right, it exercises
// an actual collision.
//
// This test is a deliberate falsifiability check on the fix itself: it was
// run once with `resumeAction`'s `excludeNodes: sources` temporarily
// replaced with `excludeNodes: []` and confirmed to FAIL (the resumed run
// re-halts forever on the stale "still no" verdict, cost 2 -> never
// verifies) - proving this test really exercises the exclusion mechanism,
// not just incidental prompt differences. With the real fix, `crit` is
// forced to make a genuine fresh call and the run verifies.
test('resume forces a real re-invocation of the node whose evidence composed the reconstructed feedback, even when that would otherwise be a byte-identical cache hit', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'lr-resume-stale-'))
  writeFileSync(join(cwd, 'looprail.yaml'), `
name: resume-stale-fixture
goal: Do it.
agents:
  worker: { adapter: mock }
  checker: { adapter: mock }
graph:
  do:   { role: executor, agent: worker }
  crit: { role: critic, agent: checker, of: do, after: do }
rails:
  max_iterations: 2
  max_cost_usd: 5
`)
  // `do` ignores feedback entirely (always "SAME") and `crit` always fails
  // with the identical evidence text - a deliberately stuck loop, so
  // iteration 2's own prompts exactly reproduce what a naive resume would
  // reconstruct for the next iteration.
  const stableAdapter: Adapter = {
    name: 'mock',
    invoke: async (req) => (/CRITIC/.test(req.prompt)
      ? { output: 'VERDICT: fail\nEVIDENCE: still no', costUsd: 0.1, tokens: 0, durationMs: 1 }
      : { output: 'SAME', costUsd: 0.1, tokens: 0, durationMs: 1 }),
  }
  const registry = createRegistry()
  registry.register(stableAdapter)
  const { io, lines } = capture()
  const code = await runAction(undefined, { cwd, json: true }, { io, registry })
  expect(code).toBe(2) // halted: still failing after max_iterations: 2, stuck on the same evidence both times
  const runId = (JSON.parse(lines.at(-1)!) as { runId: string }).runId

  // A fresh adapter that behaves differently for real: crit now genuinely
  // passes. If the resumed run's crit call were served from the stale
  // iteration-2 cache entry instead of really invoking this adapter, the
  // run would keep replaying "still no" and never verify.
  const calls: string[] = []
  const freshAdapter: Adapter = {
    name: 'mock',
    invoke: async (req) => {
      calls.push(req.prompt)
      return /CRITIC/.test(req.prompt)
        ? { output: 'VERDICT: pass\nEVIDENCE: fresh look, actually fine', costUsd: 0.1, tokens: 0, durationMs: 1 }
        : { output: 'SAME', costUsd: 0.1, tokens: 0, durationMs: 1 }
    },
  }
  const registry2 = createRegistry()
  registry2.register(freshAdapter)
  const { io: io2, lines: lines2 } = capture()
  const code2 = await resumeAction(runId, { cwd, json: true, maxIterations: 5 }, { io: io2, registry: registry2 })
  expect(code2).toBe(0) // verified - proves crit was genuinely re-invoked, not cache-replayed
  const summary = JSON.parse(lines2.at(-1)!) as { report: { claims: { claim: string; reason: string }[] } }
  expect(summary.report.claims.some((c) => c.reason === 'fresh look, actually fine')).toBe(true)
  expect(calls.some((p) => /CRITIC/.test(p))).toBe(true) // crit really was called for real
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

test('resume with raised replan_limit lets a run that already breached its old limit keep going and verify', async () => {
  const { cwd, runId } = await haltedRun()
  const { io, lines } = capture()
  const code = await resumeAction(runId, { cwd, json: true, maxIterations: 3, replanLimit: 5 }, { io, registry: passingRegistry() })
  expect(code).toBe(0)
  expect((JSON.parse(lines.at(-1)!) as { status: string }).status).toBe('verified')
})

test('resume applies a replanLimit override to the run\'s own persisted def, so the resumed run actually runs with the raised limit', async () => {
  const { cwd, runId } = await haltedRun()
  const runDir = join(runsRoot(cwd), runId)
  await resumeAction(runId, { cwd, json: true, maxIterations: 3, replanLimit: 7 }, { io: capture().io, registry: passingRegistry() })
  const { loadRunLoopDef } = await import('../journal/loopfile-persist.js')
  expect(loadRunLoopDef(runDir)?.rails.replanLimit).toBe(7)
})

test('resume without a replanLimit override leaves the loopfile\'s own rails.replanLimit untouched', async () => {
  const { cwd, runId } = await haltedRun()
  const runDir = join(runsRoot(cwd), runId)
  await resumeAction(runId, { cwd, json: true, maxIterations: 3 }, { io: capture().io, registry: passingRegistry() })
  // FIXTURE has no replan_limit, so resuming without an override must not
  // silently invent one on the persisted def.
  const { loadRunLoopDef } = await import('../journal/loopfile-persist.js')
  expect(loadRunLoopDef(runDir)?.rails.replanLimit).toBeUndefined()
})

test('resume with a goal override actually changes the goal the resumed run executes with (executor prompt + persisted def)', async () => {
  const { cwd, runId } = await haltedRun()
  const runDir = join(runsRoot(cwd), runId)
  const registry = createRegistry()
  const mock = new MockAdapter([
    { match: /EXECUTOR/, output: 'DONE', costUsd: 1 },
    { match: /CRITIC/, output: 'VERDICT: pass\nEVIDENCE: ok', costUsd: 0.2 },
  ])
  registry.register(mock)
  const newGoal = 'Say DONE, but clearly this time.'
  const code = await resumeAction(runId, { cwd, json: true, maxIterations: 3, goal: newGoal }, { io: capture().io, registry })
  expect(code).toBe(0)
  // Behavioral: the executor actually saw the new goal in its prompt,
  const executorCall = mock.calls.find((c) => /EXECUTOR/.test(c.prompt))
  expect(executorCall?.prompt).toContain(newGoal)
  // and the run's own persisted def (what the dashboard/resume reads) carries it.
  const { loadRunLoopDef } = await import('../journal/loopfile-persist.js')
  expect(loadRunLoopDef(runDir)?.goal).toBe(newGoal)
})

test('resume without a goal override leaves the loopfile\'s own goal untouched', async () => {
  const { cwd, runId } = await haltedRun()
  const runDir = join(runsRoot(cwd), runId)
  await resumeAction(runId, { cwd, json: true, maxIterations: 3 }, { io: capture().io, registry: passingRegistry() })
  const { loadRunLoopDef } = await import('../journal/loopfile-persist.js')
  expect(loadRunLoopDef(runDir)?.goal).toBe('Say DONE.')
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

// The whole point of parking (router.ts's parked branch): a gate timeout
// costs nothing. The run halts resumable, and on resume the gate simply asks
// again - the executor's already-done work comes from the journal cache, so
// the human answering late never pays for the work twice.
test('a run parked at a gate timeout resumes cleanly: the gate asks again, prior work is cached, and approval verifies the run', async () => {
  const GATED = `
name: parked-resume-fixture
goal: Say DONE.
agents:
  worker: { adapter: mock }
graph:
  do:      { role: executor, agent: worker }
  approve: { role: gate, after: do }
rails:
  max_iterations: 2
  max_cost_usd: 5
  gate_timeout: 5
`
  const cwd = mkdtempSync(join(tmpdir(), 'lr-parked-'))
  writeFileSync(join(cwd, 'looprail.yaml'), GATED)
  const registry = () => {
    const r = createRegistry()
    r.register(new MockAdapter([{ match: /EXECUTOR/, output: 'DONE', costUsd: 1 }]))
    return r
  }
  // First run: the gate times out (injected timer) - run parks.
  const first = capture()
  const { makeGate } = await import('./run-cmd.js')
  const { parseLoopfile } = await import('../index.js')
  const def = parseLoopfile(GATED)
  const timingOutGate = makeGate(def.rails, first.io, false, cwd, {
    gateTimer: async (_ms, message) => { throw new Error(message) },
  })
  const code1 = await runAction(undefined, { cwd, json: true }, { io: first.io, registry: registry(), gate: timingOutGate })
  expect(code1).toBe(2)
  const parsed1 = JSON.parse(first.lines.at(-1)!) as { runId: string; reason: string }
  expect(parsed1.reason).toContain('parked awaiting human approval')

  // Resume: the human is present this time and approves - and the executor
  // must NOT re-run (its result is served from the journal cache).
  const asked: string[] = []
  const approvingGate = async (node: { id: string }) => { asked.push(node.id); return { approved: true } }
  const second = capture()
  const boom = createRegistry()
  boom.register({ name: 'mock', invoke: async () => { throw new Error('executor must be served from cache, not re-run') } } as Adapter)
  const code2 = await resumeAction(parsed1.runId, { cwd, json: true }, { io: second.io, registry: boom, gate: approvingGate })
  expect(code2).toBe(0)
  expect(asked).toEqual(['approve'])
  const parsed2 = JSON.parse(second.lines.at(-1)!) as { status: string }
  expect(parsed2.status).toBe('verified')
})

// Real bug caught live during the queue benchmark: a run started from
// `file: ship-check.yaml` parked at its gate; resuming it with no --file
// re-read the workspace's DEFAULT looprail.yaml and silently continued the
// parked run with a completely different graph (and billed for it). The
// run's own persisted loopfile.json is the resume default; --file still
// deliberately overrides.
test('resume with no --file continues the loopfile the run was STARTED from, not the workspace default', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'lr-resume-file-'))
  // the workspace default is a DIFFERENT graph - resuming into it is the bug
  writeFileSync(join(cwd, 'looprail.yaml'), `
name: wrong-default
goal: Never this.
agents:
  worker: { adapter: mock }
graph:
  wrong: { role: executor, agent: worker }
rails: { max_iterations: 2, max_cost_usd: 5 }
`)
  writeFileSync(join(cwd, 'alt.yaml'), `
name: the-real-run
goal: Say DONE.
agents:
  worker: { adapter: mock }
graph:
  do:      { role: executor, agent: worker }
  approve: { role: gate, after: do }
rails: { max_iterations: 2, max_cost_usd: 5, gate_timeout: 5 }
`)
  const reg = () => {
    const r = createRegistry()
    r.register(new MockAdapter([{ match: /EXECUTOR/, output: 'DONE', costUsd: 1 }]))
    return r
  }
  const { makeGate } = await import('./run-cmd.js')
  const { parseLoopfile } = await import('../index.js')
  const first = capture()
  const timingOutGate = makeGate(parseLoopfile(readFileSync(join(cwd, 'alt.yaml'), 'utf8')).rails, first.io, false, cwd, {
    gateTimer: async (_ms, message) => { throw new Error(message) },
  })
  const code1 = await runAction('alt.yaml', { cwd, json: true }, { io: first.io, registry: reg(), gate: timingOutGate })
  expect(code1).toBe(2) // parked

  const parsed1 = JSON.parse(first.lines.at(-1)!) as { runId: string }
  const asked: string[] = []
  const approvingGate = async (node: { id: string }) => { asked.push(node.id); return { approved: true } }
  // a registry that throws proves the executor came from cache AND that the
  // wrong-default graph (whose node would have to actually run) wasn't used
  const boom = createRegistry()
  boom.register({ name: 'mock', invoke: async () => { throw new Error('must not invoke any agent') } } as Adapter)
  const second = capture()
  const code2 = await resumeAction(parsed1.runId, { cwd, json: true }, { io: second.io, registry: boom, gate: approvingGate })
  expect(code2).toBe(0)
  expect(asked).toEqual(['approve']) // alt.yaml's gate, not wrong-default's graph
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
