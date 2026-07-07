import { expect, test } from 'vitest'
import { routeIteration } from './router.js'
import { verdictFingerprint } from './fingerprint.js'
import type { NodeOutcome, Rails } from './types.js'

const rails: Rails = { maxIterations: 8, maxCostUsd: 10, stallAfter: 3, replanLimit: 2 }
const outcome = (nodeId: string, status: 'pass' | 'fail' | 'error', evidence = 'e'): NodeOutcome => ({
  nodeId, role: 'judge', output: '', costUsd: 0, tokens: 0, durationMs: 0,
  verdict: { node: nodeId, status, evidence },
})
const fp = (outs: NodeOutcome[]) => verdictFingerprint(outs.map((o) => o.verdict!))

test('all pass → verified', () => {
  const d = routeIteration({
    outcomes: [outcome('j', 'pass')], policy: { kind: 'all-pass' },
    fingerprints: [], rails, replansUsed: 0, breach: null,
  })
  expect(d).toEqual({ action: 'verified' })
})

test('verified wins over breach when verifiers passed', () => {
  const d = routeIteration({
    outcomes: [outcome('j', 'pass')], policy: { kind: 'all-pass' },
    fingerprints: [], rails, replansUsed: 0,
    breach: { rail: 'cost', detail: 'over budget' },
  })
  expect(d).toEqual({ action: 'verified' })
})

test('breach → halt with rail detail when verifiers did not pass', () => {
  const d = routeIteration({
    outcomes: [outcome('j', 'fail')], policy: { kind: 'all-pass' },
    fingerprints: [], rails, replansUsed: 0,
    breach: { rail: 'cost', detail: 'over budget' },
  })
  expect(d).toMatchObject({ action: 'halt', reason: expect.stringContaining('over budget') })
})

test('failure → iterate with feedback from failing verdicts', () => {
  const outs = [outcome('test', 'fail', 'boom'), outcome('crit', 'pass')]
  const d = routeIteration({
    outcomes: outs, policy: { kind: 'all-pass' },
    fingerprints: [fp(outs)], rails, replansUsed: 0, breach: null,
  })
  expect(d).toMatchObject({ action: 'iterate' })
  expect((d as { feedback: string }).feedback).toContain('[test] boom')
  expect((d as { feedback: string }).feedback).not.toContain('crit')
})

test('stall → replan while budget remains, halt after replanLimit', () => {
  const outs = [outcome('test', 'fail', 'boom')]
  const stalled = [fp(outs), fp(outs), fp(outs)]
  const replan = routeIteration({
    outcomes: outs, policy: { kind: 'all-pass' },
    fingerprints: stalled, rails, replansUsed: 1, breach: null,
  })
  expect(replan.action).toBe('replan')
  const halt = routeIteration({
    outcomes: outs, policy: { kind: 'all-pass' },
    fingerprints: stalled, rails, replansUsed: 2, breach: null,
  })
  expect(halt).toMatchObject({ action: 'halt', reason: expect.stringContaining('stall') })
})

test('transient error verdict routes like a failure (iterate with feedback)', () => {
  const d = routeIteration({
    outcomes: [outcome('j', 'error', 'adapter died')], policy: { kind: 'all-pass' },
    fingerprints: [], rails, replansUsed: 0, breach: null,
  })
  expect(d).toMatchObject({ action: 'iterate' })
  expect((d as { feedback: string }).feedback).toContain('adapter died')
})

// A gate timeout is a human being busy, not the tool failing - it parks the
// run (resumable, presented as "resume to answer") instead of halting as an
// infrastructure error. Real halt caught live: a run that planned, survived
// review, built, and passed its tests was reported as "infrastructure error"
// purely because its human missed a 10-minute approval window.
test('parked-tagged error verdict halts as parked-awaiting-approval, never as an infrastructure error', () => {
  const d = routeIteration({
    outcomes: [outcome('approve', 'error', 'parked: gate "approve" got no human answer within 600s - resume the run to answer it')],
    policy: { kind: 'all-pass' },
    fingerprints: [], rails, replansUsed: 0, breach: null,
  })
  expect(d).toMatchObject({ action: 'halt' })
  const reason = (d as { reason: string }).reason
  expect(reason).toBe('parked awaiting human approval: gate "approve" got no human answer within 600s - resume the run to answer it')
  expect(reason).not.toContain('infrastructure')
})

test('infra-tagged error verdict halts with the evidence', () => {
  const d = routeIteration({
    outcomes: [outcome('j', 'error', 'infra: 401 unauthorized - run `looprail doctor`')],
    policy: { kind: 'all-pass' },
    fingerprints: [], rails, replansUsed: 0, breach: null,
  })
  expect(d).toMatchObject({
    action: 'halt', reason: expect.stringContaining('infrastructure'),
  })
  // verify the prefix is stripped so it does not double-label
  expect((d as { reason: string }).reason).toBe('infrastructure error: 401 unauthorized - run `looprail doctor`')
})

test('config-tagged error verdict halts loudly instead of iterating', () => {
  const d = routeIteration({
    outcomes: [outcome('metacrit', 'error', 'config: target output for "pcrit" unavailable - check graph ordering')],
    policy: { kind: 'all-pass' },
    fingerprints: [], rails, replansUsed: 0, breach: null,
  })
  expect(d).toMatchObject({ action: 'halt' })
  expect((d as { reason: string }).reason).not.toContain('infrastructure')
  expect((d as { reason: string }).reason).toContain('metacrit')
  expect((d as { reason: string }).reason).toContain('pcrit')
  // verify the prefix is stripped so it does not double-label
  expect((d as { reason: string }).reason).toBe('config error - check your loop definition: [metacrit] target output for "pcrit" unavailable - check graph ordering')
})


// EFF-4: the convergence breaker halts a plateaued loop even with no
// stall_after configured, instead of grinding to the iteration/wall rail.
test('the convergence breaker halts after 3 byte-identical failing iterations when stall_after is unset', () => {
  const fp = 'crit:fail'
  const noStall: Rails = { maxIterations: 8, maxCostUsd: 10 } // stall_after deliberately unset
  const pf = 'crit:fail:still broken' // evidence-inclusive: an identical failure
  const twice = routeIteration({
    outcomes: [outcome('crit', 'fail', 'still broken')],
    policy: { kind: 'all-pass' },
    fingerprints: [fp, fp], progressFingerprints: [pf, pf], rails: noStall, replansUsed: 0, breach: null,
  })
  expect(twice.action).toBe('iterate') // only 2 identical - not a plateau yet

  const thrice = routeIteration({
    outcomes: [outcome('crit', 'fail', 'still broken')],
    policy: { kind: 'all-pass' },
    fingerprints: [fp, fp, fp], progressFingerprints: [pf, pf, pf], rails: noStall, replansUsed: 0, breach: null,
  })
  expect(thrice.action).toBe('halt')
  expect((thrice as { reason: string }).reason).toContain('not converging')
})

test('an explicit stall_after governs instead of the default breaker (may replan, not just halt)', () => {
  const fp = 'crit:fail'
  const d = routeIteration({
    outcomes: [outcome('crit', 'fail', 'x')],
    policy: { kind: 'all-pass' },
    fingerprints: [fp, fp], rails: { ...rails, stallAfter: 2, replanLimit: 1 },
    replansUsed: 0, breach: null,
  })
  expect(d.action).toBe('replan') // stall_after path, not the not-converging halt
})

test('the convergence breaker does NOT trip when the failure evidence changes each iteration (genuine progress)', () => {
  const noStall: Rails = { maxIterations: 8, maxCostUsd: 10 }
  const d = routeIteration({
    outcomes: [outcome('crit', 'fail', 'attempt 3 still wrong')],
    policy: { kind: 'all-pass' },
    // same node+status fingerprint, but DIFFERENT evidence each round
    fingerprints: ['crit:fail', 'crit:fail', 'crit:fail'],
    progressFingerprints: ['crit:fail:attempt 1 wrong', 'crit:fail:attempt 2 wrong', 'crit:fail:attempt 3 still wrong'],
    rails: noStall, replansUsed: 0, breach: null,
  })
  expect(d.action).toBe('iterate') // the executor is trying new things - keep going
})
