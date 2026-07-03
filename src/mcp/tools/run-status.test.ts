import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { runsRoot, type JournalEvent } from '../../index.js'
import { runStatusHandler } from './run-status.js'

function ev(type: JournalEvent['type'], data: Record<string, unknown>): JournalEvent {
  return { ts: 0, type, data }
}

function writeRun(cwd: string, runId: string, events: JournalEvent[]): void {
  const dir = join(cwd, '.looprail', 'runs', runId)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'journal.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n')
}

function tmpCwd(): string {
  return mkdtempSync(join(tmpdir(), 'lr-mcp-status-'))
}

test('reports status for an explicit runId', async () => {
  const cwd = tmpCwd()
  writeRun(cwd, 'run-1', [
    ev('run_start', { runId: 'run-1', name: 'demo' }),
    ev('iteration_end', { iteration: 1, costUsd: 0.2 }),
    ev('verified', { reason: 'ok', costUsd: 0.2 }),
  ])
  const result = await runStatusHandler({ runId: 'run-1' }, { cwd })
  expect(result.isError).toBeFalsy()
  const parsed = JSON.parse((result.content[0] as { text: string }).text)
  expect(parsed).toMatchObject({ runId: 'run-1', status: 'verified', costUsd: 0.2 })
})

test('defaults to the latest run (by mtime) when runId is omitted', async () => {
  const cwd = tmpCwd()
  writeRun(cwd, 'run-old', [ev('run_start', { runId: 'run-old', name: 'x' })])
  writeRun(cwd, 'run-new', [ev('run_start', { runId: 'run-new', name: 'y' })])
  utimesSync(join(runsRoot(cwd), 'run-old'), new Date(1000), new Date(1000))
  utimesSync(join(runsRoot(cwd), 'run-new'), new Date(2000), new Date(2000))
  const result = await runStatusHandler({}, { cwd })
  const parsed = JSON.parse((result.content[0] as { text: string }).text)
  expect(parsed.runId).toBe('run-new')
})

test('an unknown runId returns an error result', async () => {
  const cwd = tmpCwd()
  const result = await runStatusHandler({ runId: 'nope' }, { cwd })
  expect(result.isError).toBe(true)
})

test('no runs at all returns an error result', async () => {
  const cwd = tmpCwd()
  const result = await runStatusHandler({}, { cwd })
  expect(result.isError).toBe(true)
})
