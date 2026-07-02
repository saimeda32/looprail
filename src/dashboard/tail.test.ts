import { mkdtempSync, writeFileSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { parseLines, readNewEvents, sliceNewLines } from './tail.js'

test('sliceNewLines returns only complete, newline-terminated lines past the offset', () => {
  const full = 'line one\nline two\n'
  const { lines, offset } = sliceNewLines(full, 0)
  expect(lines).toEqual(['line one', 'line two'])
  expect(offset).toBe(full.length)
})

test('sliceNewLines holds back a partial trailing line', () => {
  const full = 'line one\npartial-no-newl'
  const { lines, offset } = sliceNewLines(full, 0)
  expect(lines).toEqual(['line one'])
  expect(offset).toBe('line one\n'.length) // partial tail NOT consumed
})

test('sliceNewLines from a non-zero offset only returns newly-appended lines', () => {
  const first = 'line one\n'
  const full = first + 'line two\n'
  const { lines, offset } = sliceNewLines(full, first.length)
  expect(lines).toEqual(['line two'])
  expect(offset).toBe(full.length)
})

test('parseLines skips a corrupt/partial JSON line without throwing', () => {
  const events = parseLines(['{"ts":1,"type":"run_start","data":{}}', 'not json{{{'])
  expect(events).toEqual([{ ts: 1, type: 'run_start', data: {} }])
})

test('readNewEvents reads real appended lines from a real file, advancing the offset', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lr-tail-'))
  const path = join(dir, 'journal.jsonl')
  writeFileSync(path, '{"ts":1,"type":"run_start","data":{"runId":"r","name":"n","goal":"g"}}\n')
  const first = readNewEvents(path, 0)
  expect(first.events).toHaveLength(1)

  appendFileSync(path, '{"ts":2,"type":"node_start","data":{"nodeId":"do","role":"executor","iteration":1}}\n')
  const second = readNewEvents(path, first.offset)
  expect(second.events).toEqual([{ ts: 2, type: 'node_start', data: { nodeId: 'do', role: 'executor', iteration: 1 } }])

  const third = readNewEvents(path, second.offset)
  expect(third.events).toEqual([])
  expect(third.offset).toBe(second.offset)
})
