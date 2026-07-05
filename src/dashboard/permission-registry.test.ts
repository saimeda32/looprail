import { expect, test } from 'vitest'
import {
  getPendingPermission,
  pendingPermissions,
  permissionKey,
  registerPendingPermission,
  resolvePendingPermission,
  sweepPendingPermissions,
} from './permission-registry.js'

test('permissionKey combines runId and nodeId deterministically', () => {
  expect(permissionKey('run-1', 'build')).toBe('run-1:build')
})

test('register then resolve settles the awaited promise with the exact answer string, and clears the entry', async () => {
  const received: string[] = []
  const answered = new Promise<string>((resolve) => {
    registerPendingPermission({
      resolve,
      question: 'Allow writing to package.json?',
      nodeId: 'build',
      runId: 'run-a',
    })
  })
  answered.then((a) => received.push(a))

  expect(getPendingPermission('run-a')).toMatchObject({ nodeId: 'build', runId: 'run-a' })

  const found = resolvePendingPermission('run-a', 'build', 'y\n')
  expect(found).toBe(true)

  await answered
  expect(received).toEqual(['y\n'])
  expect(pendingPermissions.has(permissionKey('run-a', 'build'))).toBe(false)
})

test('resolving a key with no pending entry returns false and is a harmless no-op', () => {
  const found = resolvePendingPermission('run-nope', 'nope', 'y')
  expect(found).toBe(false)
})

test('resolving twice: the second call misses cleanly (already deleted)', async () => {
  const received: string[] = []
  const answered = new Promise<string>((resolve) => {
    registerPendingPermission({
      resolve,
      question: 'ctx',
      nodeId: 'g',
      runId: 'run-c',
    })
  })
  answered.then((a) => received.push(a))

  expect(resolvePendingPermission('run-c', 'g', 'y')).toBe(true)
  await answered
  expect(resolvePendingPermission('run-c', 'g', 'n')).toBe(false)
  expect(received).toEqual(['y'])
})

test('getPendingPermission returns the pending entry only while unresolved', () => {
  registerPendingPermission({
    resolve: () => {},
    question: 'ctx',
    nodeId: 'g2',
    runId: 'run-d',
  })
  expect(getPendingPermission('run-d')).toMatchObject({ nodeId: 'g2' })

  resolvePendingPermission('run-d', 'g2', 'y')
  expect(getPendingPermission('run-d')).toBeUndefined()
})

test('getPendingPermission returns undefined for a runId with nothing pending', () => {
  expect(getPendingPermission('run-never-existed')).toBeUndefined()
})

test('sweepPendingPermissions clears only entries for the target runId, leaving others intact', () => {
  registerPendingPermission({ resolve: () => {}, question: 'a', nodeId: 'n1', runId: 'run-e' })
  registerPendingPermission({ resolve: () => {}, question: 'b', nodeId: 'n2', runId: 'run-e' })
  registerPendingPermission({ resolve: () => {}, question: 'c', nodeId: 'n3', runId: 'run-f' })

  sweepPendingPermissions('run-e')

  expect(getPendingPermission('run-e')).toBeUndefined()
  expect(pendingPermissions.has(permissionKey('run-e', 'n1'))).toBe(false)
  expect(pendingPermissions.has(permissionKey('run-e', 'n2'))).toBe(false)
  expect(getPendingPermission('run-f')).toMatchObject({ nodeId: 'n3' })

  sweepPendingPermissions('run-f')
})
