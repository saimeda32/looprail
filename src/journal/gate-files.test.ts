import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import {
  consumeGateAnswer, discardStaleGateAnswer, gateAnswerPath,
  readGateWaitingMarker, removeGateWaitingMarker, writeGateAnswer, writeGateWaitingMarker,
} from './gate-files.js'

function runDir(): string {
  return mkdtempSync(join(tmpdir(), 'lr-gate-files-'))
}

test('gate answer round-trips, and consuming it deletes the file so it applies exactly once', () => {
  const dir = runDir()
  writeGateAnswer(dir, { approved: false, feedback: 'tighten the tester' })
  expect(consumeGateAnswer(dir)).toEqual({ approved: false, feedback: 'tighten the tester' })
  expect(existsSync(gateAnswerPath(dir))).toBe(false)
  expect(consumeGateAnswer(dir)).toBeUndefined() // second read: already consumed
})

test('consumeGateAnswer returns undefined when no answer exists yet - the polling steady state', () => {
  expect(consumeGateAnswer(runDir())).toBeUndefined()
})

test('a malformed or wrong-shaped answer file never approves a gate by accident', () => {
  const dir = runDir()
  writeFileSync(gateAnswerPath(dir), 'not json at all')
  expect(consumeGateAnswer(dir)).toBeUndefined()
  writeFileSync(gateAnswerPath(dir), JSON.stringify({ something: 'else' }))
  expect(consumeGateAnswer(dir)).toBeUndefined()
})

test('discardStaleGateAnswer removes a leftover answer so it cannot approve a future gate unseen', () => {
  const dir = runDir()
  writeGateAnswer(dir, { approved: true })
  discardStaleGateAnswer(dir)
  expect(consumeGateAnswer(dir)).toBeUndefined()
})

test('gate-waiting marker round-trips and removal is idempotent', () => {
  const dir = runDir()
  writeGateWaitingMarker(dir, { nodeId: 'approve', isPlanApproval: true, question: 'plan ok?' })
  expect(readGateWaitingMarker(dir)).toEqual({ nodeId: 'approve', isPlanApproval: true, question: 'plan ok?' })
  removeGateWaitingMarker(dir)
  expect(readGateWaitingMarker(dir)).toBeUndefined()
  removeGateWaitingMarker(dir) // already gone - must not throw
})
