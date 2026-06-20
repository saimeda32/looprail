import { expect, test } from 'vitest'
import { composeFeedback, routeIteration } from './router.js'
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

test('infra-tagged error verdict halts with the evidence', () => {
  const d = routeIteration({
    outcomes: [outcome('j', 'error', 'infra: 401 unauthorized — run `looprail doctor`')],
    policy: { kind: 'all-pass' },
    fingerprints: [], rails, replansUsed: 0, breach: null,
  })
  expect(d).toMatchObject({
    action: 'halt', reason: expect.stringContaining('infrastructure'),
  })
  // verify the prefix is stripped so it does not double-label
  expect((d as { reason: string }).reason).toBe('infrastructure error: 401 unauthorized — run `looprail doctor`')
})

test('config-tagged error verdict halts loudly instead of iterating', () => {
  const d = routeIteration({
    outcomes: [outcome('metacrit', 'error', 'config: target output for "pcrit" unavailable — check graph ordering')],
    policy: { kind: 'all-pass' },
    fingerprints: [], rails, replansUsed: 0, breach: null,
  })
  expect(d).toMatchObject({ action: 'halt' })
  expect((d as { reason: string }).reason).not.toContain('infrastructure')
  expect((d as { reason: string }).reason).toContain('metacrit')
  expect((d as { reason: string }).reason).toContain('pcrit')
  // verify the prefix is stripped so it does not double-label
  expect((d as { reason: string }).reason).toBe('config error — check your loop definition: [metacrit] target output for "pcrit" unavailable — check graph ordering')
})
