import { expect, test } from 'vitest'
import type { JournalEvent } from '../core/types.js'
import { buildReplay, encodeSseFrame } from './sse.js'

test('encodeSseFrame frames one event as data: <json>\\n\\n', () => {
  const event: JournalEvent = { ts: 1, type: 'node_start', data: { nodeId: 'do', role: 'executor', iteration: 1 } }
  const frame = encodeSseFrame(event)
  expect(frame).toBe(`data: ${JSON.stringify(event)}\n\n`)
  expect(frame.endsWith('\n\n')).toBe(true)
})

test('buildReplay concatenates frames in the given order', () => {
  const events: JournalEvent[] = [
    { ts: 1, type: 'run_start', data: { runId: 'r', name: 'n', goal: 'g' } },
    { ts: 2, type: 'node_start', data: { nodeId: 'do', role: 'executor', iteration: 1 } },
  ]
  const replay = buildReplay(events)
  expect(replay).toBe(encodeSseFrame(events[0]) + encodeSseFrame(events[1]))
})

test('buildReplay on an empty array is an empty string', () => {
  expect(buildReplay([])).toBe('')
})
