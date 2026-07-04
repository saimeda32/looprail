import { readFileSync, watch } from 'node:fs'
import type { JournalEvent } from '../core/types.js'

export interface LineSlice { lines: string[]; offset: number }

// Pure: given the file's full text and a byte offset already consumed,
// returns the newly appended, complete (newline-terminated) lines and the
// new offset. A partial trailing line (still being written) is held back - 
// its bytes are not counted into the returned offset, so the next call
// re-reads it once it's complete.
export function sliceNewLines(fullText: string, offset: number): LineSlice {
  const appended = fullText.slice(offset)
  const lastNewline = appended.lastIndexOf('\n')
  if (lastNewline === -1) return { lines: [], offset }
  const complete = appended.slice(0, lastNewline)
  const lines = complete.split('\n').filter((l) => l.trim().length > 0)
  return { lines, offset: offset + lastNewline + 1 }
}

// Pure: mirrors readJournal's per-line try/catch (journal.ts) - a trailing
// partial line from a crash mid-write is ignored, not thrown.
export function parseLines(lines: string[]): JournalEvent[] {
  const events: JournalEvent[] = []
  for (const line of lines) {
    try {
      events.push(JSON.parse(line) as JournalEvent)
    } catch {
      // corrupt/partial line - ignore
    }
  }
  return events
}

export function readNewEvents(path: string, offset: number): { events: JournalEvent[]; offset: number } {
  const fullText = readFileSync(path, 'utf8')
  const { lines, offset: next } = sliceNewLines(fullText, offset)
  return { events: parseLines(lines), offset: next }
}

export type Watcher = (path: string, onChange: () => void) => { close(): void }

// The one genuinely impure export in this file. Injected everywhere it's
// used (server.ts) so tests never touch a real fs.watch handle.
export const fsWatcher: Watcher = (path, onChange) => {
  const watcher = watch(path, { persistent: false }, () => onChange())
  return { close: () => watcher.close() }
}
