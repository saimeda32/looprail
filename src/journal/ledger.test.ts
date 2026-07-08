import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { appendLedgerEntry, readLedger, verifyLedger, type LedgerEntryInput } from './ledger.js'

const input = (over: Partial<LedgerEntryInput> = {}): LedgerEntryInput => ({
  runId: 'run-x', iteration: 1, node: 'crit', role: 'critic',
  verdict: { status: 'pass', evidence: 'looks right' },
  outputSha256: 'a'.repeat(64),
  ...over,
})

describe('evidence ledger', () => {
  test('entries chain: each hash covers the entry and the previous hash', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lr-ledger-'))
    const path = join(dir, 'ledger.jsonl')
    appendLedgerEntry(path, input(), () => 1000)
    appendLedgerEntry(path, input({ node: 'tests', role: 'tester', verdict: { status: 'fail', evidence: 'exit 1' } }), () => 2000)
    const entries = readLedger(path)
    expect(entries).toHaveLength(2)
    expect(entries[0].seq).toBe(1)
    expect(entries[1].seq).toBe(2)
    expect(entries[0].prevHash).toBe('0'.repeat(64))
    expect(entries[1].prevHash).toBe(entries[0].hash)
    expect(verifyLedger(path)).toEqual({ ok: true, entries: 2 })
  })

  test('verify detects a tampered entry and names where the chain breaks', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lr-ledger2-'))
    const path = join(dir, 'ledger.jsonl')
    appendLedgerEntry(path, input(), () => 1000)
    appendLedgerEntry(path, input({ iteration: 2 }), () => 2000)
    appendLedgerEntry(path, input({ iteration: 3 }), () => 3000)
    // rewrite history: flip entry 2's verdict from pass to fail
    const lines = readFileSync(path, 'utf8').trim().split('\n')
    lines[1] = lines[1].replace('"pass"', '"fail"')
    writeFileSync(path, lines.join('\n') + '\n')
    const result = verifyLedger(path)
    expect(result.ok).toBe(false)
    expect(result.brokenAtSeq).toBe(2)
  })

  test('verify detects a DELETED entry (chain gap)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lr-ledger3-'))
    const path = join(dir, 'ledger.jsonl')
    appendLedgerEntry(path, input(), () => 1000)
    appendLedgerEntry(path, input({ iteration: 2 }), () => 2000)
    appendLedgerEntry(path, input({ iteration: 3 }), () => 3000)
    const lines = readFileSync(path, 'utf8').trim().split('\n')
    writeFileSync(path, [lines[0], lines[2]].join('\n') + '\n')
    const result = verifyLedger(path)
    expect(result.ok).toBe(false)
  })

  test('a new run continues the existing chain instead of restarting it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lr-ledger4-'))
    const path = join(dir, 'ledger.jsonl')
    appendLedgerEntry(path, input({ runId: 'run-1' }), () => 1000)
    appendLedgerEntry(path, input({ runId: 'run-2' }), () => 2000)
    const entries = readLedger(path)
    expect(entries[1].prevHash).toBe(entries[0].hash)
    expect(verifyLedger(path)).toEqual({ ok: true, entries: 2 })
  })

  test('an empty or missing ledger verifies trivially', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lr-ledger5-'))
    expect(verifyLedger(join(dir, 'nope.jsonl'))).toEqual({ ok: true, entries: 0 })
  })
})
