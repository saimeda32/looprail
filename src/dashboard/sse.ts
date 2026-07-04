import type { JournalEvent } from '../core/types.js'

// One SSE frame carrying one raw JournalEvent as its payload. The browser
// never needs an `event:` name - every message means "a journal event
// happened, go re-fetch /model" (see design decision 7 in the plan).
export function encodeSseFrame(event: JournalEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`
}

export function buildReplay(events: JournalEvent[]): string {
  return events.map(encodeSseFrame).join('')
}
