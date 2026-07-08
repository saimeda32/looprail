import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { VerdictStatus } from '../core/types.js'

// The evidence ledger: a hash-chained, repo-committable record of every
// verdict a run produced - who judged what, with what evidence, and a
// digest of the output it judged. The journal (~/.looprail) is looprail's
// own operational history; the ledger is the PROJECT's audit artifact,
// designed to live in the repo and survive review ("this change was
// verified by <model> on <date>, and here is the tamper-evident chain").
// Each entry's hash covers the entry AND the previous entry's hash, so
// editing or deleting any historical entry breaks every hash after it -
// `looprail ledger verify` recomputes the chain and names the break.
//
// Chain integrity is tamper-EVIDENT, not tamper-PROOF: whoever can rewrite
// the whole file can rebuild the whole chain. Committing the ledger to git
// is what makes rewrites visible (the chain pins content; git pins history).

export interface LedgerVerdict {
  status: VerdictStatus
  evidence: string
  score?: number
  gaps?: string[]
}

export interface LedgerEntryInput {
  runId: string
  iteration: number
  node: string
  role: string
  verdict: LedgerVerdict
  // sha256 of the full node output the verdict judged - the output itself
  // may be huge or sensitive, so the ledger pins it by digest and the
  // journal remains the place to read it.
  outputSha256: string
  agent?: string
  adapter?: string
  model?: string
}

export interface LedgerEntry extends LedgerEntryInput {
  seq: number
  ts: number
  prevHash: string
  hash: string
}

const GENESIS = '0'.repeat(64)

// Canonical serialization for hashing: the entry WITHOUT its own hash,
// with keys in a fixed order via JSON.stringify of an explicitly-built
// object (property order is insertion order, and buildHashable inserts in
// one fixed sequence).
function entryHash(entry: Omit<LedgerEntry, 'hash'>): string {
  const hashable = {
    seq: entry.seq, ts: entry.ts, runId: entry.runId, iteration: entry.iteration,
    node: entry.node, role: entry.role, verdict: entry.verdict,
    outputSha256: entry.outputSha256,
    agent: entry.agent ?? null, adapter: entry.adapter ?? null, model: entry.model ?? null,
    prevHash: entry.prevHash,
  }
  return createHash('sha256').update(JSON.stringify(hashable)).digest('hex')
}

export function readLedger(path: string): LedgerEntry[] {
  if (!existsSync(path)) return []
  const entries: LedgerEntry[] = []
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue
    try {
      entries.push(JSON.parse(line) as LedgerEntry)
    } catch {
      // a corrupt line still counts against verification - represent it as
      // a hash-breaking placeholder rather than silently skipping it
      entries.push({ seq: -1, ts: 0, runId: '', iteration: 0, node: '', role: '', verdict: { status: 'error', evidence: 'unparseable ledger line' }, outputSha256: '', prevHash: '', hash: '' })
    }
  }
  return entries
}

export function appendLedgerEntry(
  path: string, input: LedgerEntryInput, now: () => number = Date.now,
): LedgerEntry {
  const prior = readLedger(path)
  const prev = prior[prior.length - 1]
  const withoutHash: Omit<LedgerEntry, 'hash'> = {
    ...input,
    seq: (prev?.seq ?? 0) + 1,
    ts: now(),
    prevHash: prev?.hash ?? GENESIS,
  }
  const entry: LedgerEntry = { ...withoutHash, hash: entryHash(withoutHash) }
  mkdirSync(dirname(path), { recursive: true })
  appendFileSync(path, JSON.stringify(entry) + '\n')
  return entry
}

export interface LedgerVerification {
  ok: boolean
  entries: number
  brokenAtSeq?: number
  detail?: string
}

export function verifyLedger(path: string): LedgerVerification {
  const entries = readLedger(path)
  let prevHash = GENESIS
  let prevSeq = 0
  for (const entry of entries) {
    const { hash, ...rest } = entry
    if (entry.seq !== prevSeq + 1) {
      return { ok: false, entries: entries.length, brokenAtSeq: entry.seq, detail: `sequence gap: expected seq ${prevSeq + 1}, found ${entry.seq}` }
    }
    if (entry.prevHash !== prevHash) {
      return { ok: false, entries: entries.length, brokenAtSeq: entry.seq, detail: `chain break: entry ${entry.seq}'s prevHash does not match entry ${prevSeq}'s hash` }
    }
    if (entryHash(rest) !== hash) {
      return { ok: false, entries: entries.length, brokenAtSeq: entry.seq, detail: `content tampered: entry ${entry.seq}'s hash does not match its content` }
    }
    prevHash = hash
    prevSeq = entry.seq
  }
  return { ok: true, entries: entries.length }
}
