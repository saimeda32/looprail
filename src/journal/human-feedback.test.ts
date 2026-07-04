import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { drainHumanFeedback, queueHumanFeedback } from './human-feedback.js'

const dir = () => mkdtempSync(join(tmpdir(), 'hf-'))

test('drainHumanFeedback returns undefined when nothing was ever queued', () => {
  expect(drainHumanFeedback(dir())).toBeUndefined()
})

test('queue then drain returns the note, and a second drain returns undefined', () => {
  const runDir = dir()
  queueHumanFeedback(runDir, 'watch the null case')
  expect(drainHumanFeedback(runDir)).toBe('watch the null case')
  expect(drainHumanFeedback(runDir)).toBeUndefined()
})

test('a later queue overwrites an unread earlier one', () => {
  const runDir = dir()
  queueHumanFeedback(runDir, 'first note')
  queueHumanFeedback(runDir, 'second note')
  expect(drainHumanFeedback(runDir)).toBe('second note')
})

test('a whitespace-only note drains as undefined', () => {
  const runDir = dir()
  queueHumanFeedback(runDir, '   \n  ')
  expect(drainHumanFeedback(runDir)).toBeUndefined()
})
