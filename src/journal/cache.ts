import type { NodeOutcome } from '../core/types.js'
import { readJournal } from './journal.js'

export interface LoadCacheOptions {
  // resume-cmd.ts's resumeAction excludes the halted run's own last
  // iteration: its reconstructed feedback (journal/runs.ts's
  // reconstructRunState) is built FROM that exact iteration's evidence, so
  // the resumed iteration's prompt can come out byte-identical to it - a
  // cache hit there would silently replay the very failure the user is
  // asking to retry with more budget, without a single real adapter call
  // happening. Earlier iterations' outcomes remain cached normally: their
  // contexts were built from different (earlier) feedback and can't
  // self-collide with the reconstructed one this way.
  excludeIteration?: number
}

export function loadCache(journalPath: string, opts: LoadCacheOptions = {}): Map<string, NodeOutcome> {
  const cache = new Map<string, NodeOutcome>()
  for (const event of readJournal(journalPath)) {
    if (event.type !== 'node_end') continue
    const d = event.data as unknown as NodeOutcome & { contextHash?: string; iteration?: number }
    if (opts.excludeIteration !== undefined && d.iteration === opts.excludeIteration) continue
    if (d.contextHash) cache.set(d.contextHash, { ...d })
  }
  return cache
}
