import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { whyAction } from './why-cmd.js'
import { runsRoot } from '../journal/runs.js'

function seed(cwd: string, runId: string, events: object[]): void {
  const dir = join(runsRoot(cwd), runId)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'journal.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n')
}
const cap = () => { const lines: string[] = []; return { io: { out: (l: string) => lines.push(l) }, lines } }

test('why on the latest run diagnoses a cost halt with a next step', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'lr-why-'))
  seed(cwd, 'run-1', [
    { ts: 1, type: 'node_end', data: { nodeId: 'build', iteration: 1, agent: 'worker', costUsd: 2.0, verdict: { status: 'fail', evidence: 'not done' } } },
    { ts: 2, type: 'iteration_end', data: { iteration: 1, costUsd: 2.0 } },
    { ts: 3, type: 'halt', data: { reason: 'rail breached (cost): over budget', costUsd: 2.0 } },
  ])
  const { io, lines } = cap()
  expect(whyAction(undefined, { cwd }, { io })).toBe(0)
  const text = lines.join('\n')
  expect(text).toContain('Ran out of budget')
  expect(text).toContain('worker')       // names the top spender
  expect(text).toContain('what to do:')
})

test('why --json emits a structured diagnosis', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'lr-why2-'))
  seed(cwd, 'run-x', [
    { ts: 1, type: 'iteration_end', data: { iteration: 1 } },
    { ts: 2, type: 'verified', data: { reason: 'all verifiers passed', costUsd: 0.5 } },
  ])
  const { io, lines } = cap()
  expect(whyAction('run-x', { cwd, json: true }, { io })).toBe(0)
  const d = JSON.parse(lines[0])
  expect(d.status).toBe('verified')
  expect(d.nextSteps.join(' ')).toContain('--pr')
})

test('why on an unknown run reports it cleanly', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'lr-why3-'))
  const { io, lines } = cap()
  expect(whyAction('nope', { cwd }, { io })).toBe(1)
  expect(lines.join('\n')).toContain('no run')
})

test('why on a still-running journal (no terminal event) says so, exit 0', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'lr-why4-'))
  seed(cwd, 'run-live', [{ ts: 1, type: 'node_start', data: { nodeId: 'do', iteration: 1 } }])
  const { io, lines } = cap()
  expect(whyAction('run-live', { cwd }, { io })).toBe(0)
  expect(lines.join('\n')).toContain('still be running')
})
