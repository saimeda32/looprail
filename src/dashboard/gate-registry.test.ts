import { expect, test } from 'vitest'
import type { GateAnswer } from '../index.js'
import {
  gateKey,
  getPendingGate,
  pendingGates,
  registerPendingGate,
  resolvePendingGate,
  sweepPendingGates,
} from './gate-registry.js'

test('gateKey combines runId and nodeId deterministically', () => {
  expect(gateKey('run-1', 'approve')).toBe('run-1:approve')
})

test('register then resolve settles the awaited promise with the exact GateAnswer, and clears the entry', async () => {
  const resolved: GateAnswer[] = []
  const answered = new Promise<GateAnswer>((resolve) => {
    registerPendingGate({
      resolve,
      question: 'ok to proceed?',
      nodeId: 'gate1',
      runId: 'run-a',
      isPlanApproval: false,
    })
  })
  answered.then((a) => resolved.push(a))

  expect(getPendingGate('run-a')).toMatchObject({ nodeId: 'gate1', runId: 'run-a' })

  const found = resolvePendingGate('run-a', 'gate1', { approved: true })
  expect(found).toBe(true)

  await answered
  expect(resolved).toEqual([{ approved: true }])
  expect(pendingGates.has(gateKey('run-a', 'gate1'))).toBe(false)
})

test('resolve with approved:false and feedback resolves with that exact GateAnswer', async () => {
  const resolved: GateAnswer[] = []
  const answered = new Promise<GateAnswer>((resolve) => {
    registerPendingGate({
      resolve,
      question: 'plan ok?',
      nodeId: 'plan-gate',
      runId: 'run-b',
      isPlanApproval: true,
    })
  })
  answered.then((a) => resolved.push(a))

  resolvePendingGate('run-b', 'plan-gate', { approved: false, feedback: 'add more tests' })
  await answered
  expect(resolved).toEqual([{ approved: false, feedback: 'add more tests' }])
})

test('resolving a key with no pending entry returns false and is a harmless no-op', () => {
  const found = resolvePendingGate('run-nope', 'nope', { approved: true })
  expect(found).toBe(false)
})

test('resolving twice: the second call misses cleanly (already deleted)', async () => {
  const resolved: GateAnswer[] = []
  const answered = new Promise<GateAnswer>((resolve) => {
    registerPendingGate({
      resolve,
      question: 'ctx',
      nodeId: 'g',
      runId: 'run-c',
      isPlanApproval: false,
    })
  })
  answered.then((a) => resolved.push(a))

  expect(resolvePendingGate('run-c', 'g', { approved: true })).toBe(true)
  await answered
  expect(resolvePendingGate('run-c', 'g', { approved: false })).toBe(false)
  expect(resolved).toEqual([{ approved: true }])
})

test('getPendingGate returns the pending entry only while unresolved', () => {
  registerPendingGate({
    resolve: () => {},
    question: 'ctx',
    nodeId: 'g2',
    runId: 'run-d',
    isPlanApproval: false,
  })
  expect(getPendingGate('run-d')).toMatchObject({ nodeId: 'g2' })

  resolvePendingGate('run-d', 'g2', { approved: true })
  expect(getPendingGate('run-d')).toBeUndefined()
})

test('getPendingGate returns undefined for a runId with nothing pending', () => {
  expect(getPendingGate('run-never-existed')).toBeUndefined()
})

test('sweepPendingGates clears only entries for the target runId, leaving others intact', () => {
  registerPendingGate({ resolve: () => {}, question: 'a', nodeId: 'n1', runId: 'run-e', isPlanApproval: false })
  registerPendingGate({ resolve: () => {}, question: 'b', nodeId: 'n2', runId: 'run-e', isPlanApproval: false })
  registerPendingGate({ resolve: () => {}, question: 'c', nodeId: 'n3', runId: 'run-f', isPlanApproval: false })

  sweepPendingGates('run-e')

  expect(getPendingGate('run-e')).toBeUndefined()
  expect(pendingGates.has(gateKey('run-e', 'n1'))).toBe(false)
  expect(pendingGates.has(gateKey('run-e', 'n2'))).toBe(false)
  expect(getPendingGate('run-f')).toMatchObject({ nodeId: 'n3' })

  sweepPendingGates('run-f')
})
