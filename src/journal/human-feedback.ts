import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// A human watching the dashboard can drop a note for the executor's next
// attempt, the same channel a critic's evidence uses (see core/context.ts's
// humanFeedback section) but written by a person instead of a verdict.
// Lives next to the journal, not in it, for the same reason pid/paused do
// (server.ts's controlState comment): it describes an in-flight nudge, not
// the loop's own history. A later submission overwrites an unread one -
// the file holds "my current note", not a log of every note ever sent.
function feedbackPath(runDir: string): string {
  return join(runDir, 'feedback-pending.txt')
}

export function queueHumanFeedback(runDir: string, text: string): void {
  writeFileSync(feedbackPath(runDir), text)
}

// Reads and clears the pending note in one call: this is a one-shot inbox,
// not a log, so consuming it must remove it - otherwise the same note would
// keep re-injecting into every iteration after the one it was meant for.
export function drainHumanFeedback(runDir: string): string | undefined {
  const path = feedbackPath(runDir)
  if (!existsSync(path)) return undefined
  const text = readFileSync(path, 'utf8').trim()
  try { unlinkSync(path) } catch { /* already consumed by a racing reader */ }
  return text.length > 0 ? text : undefined
}
