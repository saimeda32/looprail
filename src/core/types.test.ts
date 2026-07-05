import { expect, test } from 'vitest'
import { normalizeGateAnswer } from './types.js'

test('normalizeGateAnswer wraps a plain boolean with no feedback', () => {
  expect(normalizeGateAnswer(true)).toEqual({ approved: true })
  expect(normalizeGateAnswer(false)).toEqual({ approved: false })
})

test('normalizeGateAnswer passes a GateAnswer object through unchanged', () => {
  expect(normalizeGateAnswer({ approved: false, feedback: 'add a tests node' }))
    .toEqual({ approved: false, feedback: 'add a tests node' })
})
