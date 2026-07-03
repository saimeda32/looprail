import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { latestRunId, listRunIds, runsRoot } from './runs.js'

test('listRunIds on a cwd with no runs directory returns an empty array', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'lr-runs-'))
  expect(listRunIds(cwd)).toEqual([])
  expect(latestRunId(cwd)).toBeNull()
})

test('listRunIds returns only run dirs that have a journal, newest-modified first', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'lr-runs-'))
  const root = runsRoot(cwd)
  mkdirSync(join(root, 'run-a'), { recursive: true })
  writeFileSync(join(root, 'run-a', 'journal.jsonl'), '')
  mkdirSync(join(root, 'run-b'), { recursive: true })
  writeFileSync(join(root, 'run-b', 'journal.jsonl'), '')
  mkdirSync(join(root, 'run-c-no-journal'), { recursive: true }) // excluded: no journal.jsonl
  const ids = listRunIds(cwd)
  expect([...ids].sort()).toEqual(['run-a', 'run-b'])
  expect(latestRunId(cwd)).toBe(ids[0])
})
