import type { NodeOutcome } from '../core/types.js'
import { readJournal } from './journal.js'

export interface LoadCacheOptions {
  // resume-cmd.ts's resumeAction excludes exactly the node_end entries
  // whose own output fed the halted run's reconstructed feedback/plan
  // (journal/runs.ts's reconstructRunState returns them as `sources`): that
  // reconstruction is built FROM that node's own evidence, so the resumed
  // iteration's prompt for THAT SAME node can come out byte-identical to
  // it - a cache hit there would silently replay the very failure the user
  // is asking to retry with more budget, without a single real adapter
  // call happening.
  //
  // Every other node_end is cached normally, even ones sharing the halted
  // run's iteration number: an unrelated node that already finished (and
  // maybe already passed its own review) at that same iteration had
  // nothing to do with why the run halted, and its cached context can't
  // self-collide with the reconstructed feedback/plan the way the source
  // node's can. Excluding it too - as a coarser whole-iteration exclusion
  // once did - forces genuinely wasted, redundant re-work on resume.
  excludeNodes?: { nodeId: string; iteration: number }[]
}

function exclusionKey(nodeId: string, iteration: number): string {
  return `${nodeId}\0${iteration}`
}

export function loadCache(journalPath: string, opts: LoadCacheOptions = {}): Map<string, NodeOutcome> {
  const excluded = new Set((opts.excludeNodes ?? []).map((s) => exclusionKey(s.nodeId, s.iteration)))
  const cache = new Map<string, NodeOutcome>()
  for (const event of readJournal(journalPath)) {
    if (event.type !== 'node_end') continue
    const d = event.data as unknown as NodeOutcome & { contextHash?: string; iteration?: number }
    if (excluded.has(exclusionKey(d.nodeId, Number(d.iteration ?? 0)))) continue
    if (d.contextHash) cache.set(d.contextHash, { ...d })
  }
  return cache
}
