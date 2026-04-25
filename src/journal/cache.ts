import type { NodeOutcome } from '../core/types.js'
import { readJournal } from './journal.js'

export function loadCache(journalPath: string): Map<string, NodeOutcome> {
  const cache = new Map<string, NodeOutcome>()
  for (const event of readJournal(journalPath)) {
    if (event.type !== 'node_end') continue
    const d = event.data as unknown as NodeOutcome & { contextHash?: string }
    if (d.contextHash) cache.set(d.contextHash, { ...d })
  }
  return cache
}
