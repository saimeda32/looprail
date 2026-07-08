import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { ledgerAction } from './ledger-cmd.js'
import { appendLedgerEntry } from '../journal/ledger.js'

const capture = () => {
  const lines: string[] = []
  return { io: { out: (l: string) => lines.push(l) }, lines }
}

test('no ledger yet: friendly empty state, exit 0', () => {
  const { io, lines } = capture()
  expect(ledgerAction({ cwd: mkdtempSync(join(tmpdir(), 'lr-lcmd-')) }, { io })).toBe(0)
  expect(lines.join('\n')).toContain('ledger: true')
})

test('lists entries and verifies an intact chain', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'lr-lcmd2-'))
  const path = join(cwd, '.looprail', 'ledger.jsonl')
  appendLedgerEntry(path, {
    runId: 'run-a', iteration: 1, node: 'crit', role: 'critic',
    verdict: { status: 'pass', evidence: 'fine work' }, outputSha256: 'b'.repeat(64),
  })
  const list = capture()
  expect(ledgerAction({ cwd }, { io: list.io })).toBe(0)
  expect(list.lines.join('\n')).toContain('fine work')
  const verify = capture()
  expect(ledgerAction({ cwd, verify: true }, { io: verify.io })).toBe(0)
  expect(verify.lines.join('\n')).toContain('intact')
})

test('--verify exits 1 and names the break on a tampered chain', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'lr-lcmd3-'))
  const path = join(cwd, '.looprail', 'ledger.jsonl')
  appendLedgerEntry(path, { runId: 'r', iteration: 1, node: 'n', role: 'critic', verdict: { status: 'pass', evidence: 'e' }, outputSha256: 'c'.repeat(64) })
  appendLedgerEntry(path, { runId: 'r', iteration: 2, node: 'n', role: 'critic', verdict: { status: 'pass', evidence: 'e2' }, outputSha256: 'c'.repeat(64) })
  const { readFileSync, writeFileSync } = await import('node:fs')
  const lines = readFileSync(path, 'utf8').trim().split('\n')
  lines[0] = lines[0].replace('"pass"', '"fail"')
  writeFileSync(path, lines.join('\n') + '\n')
  const { io, lines: out } = capture()
  expect(ledgerAction({ cwd, verify: true }, { io })).toBe(1)
  expect(out.join('\n')).toContain('BROKEN at entry 1')
})
