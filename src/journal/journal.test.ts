import { appendFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { JournalWriter, readJournal } from './journal.js'

test('writes events as JSONL and reads them back', () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'lr-')), 'run-1')
  const w = new JournalWriter(dir, () => 42)
  w.write('run_start', { name: 'demo' })
  w.write('node_end', { nodeId: 'do', costUsd: 0.1 })
  const events = readJournal(w.path)
  expect(events).toEqual([
    { ts: 42, type: 'run_start', data: { name: 'demo' } },
    { ts: 42, type: 'node_end', data: { nodeId: 'do', costUsd: 0.1 } },
  ])
})

test('readJournal skips a trailing partial line', () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'lr-')), 'run-2')
  const w = new JournalWriter(dir, () => 1)
  w.write('run_start', {})
  appendFileSync(w.path, '{"ts":2,"type":"node_')
  expect(readJournal(w.path)).toHaveLength(1)
})
