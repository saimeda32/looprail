import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { JournalEvent } from '../core/types.js'

export class JournalWriter {
  readonly path: string

  constructor(runDir: string, private now: () => number = Date.now) {
    mkdirSync(runDir, { recursive: true })
    this.path = join(runDir, 'journal.jsonl')
  }

  write(type: JournalEvent['type'], data: Record<string, unknown>): void {
    const event: JournalEvent = { ts: this.now(), type, data }
    appendFileSync(this.path, JSON.stringify(event) + '\n')
  }
}

export function readJournal(path: string): JournalEvent[] {
  const events: JournalEvent[] = []
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue
    try {
      events.push(JSON.parse(line) as JournalEvent)
    } catch {
      // trailing partial line from a crash — ignore
    }
  }
  return events
}
