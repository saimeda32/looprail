import { readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { GateAnswer } from '../core/types.js'

// Cross-process gate coordination, modeled on the runDir pid/'paused' file
// pattern: live coordination state lives NEXT TO the journal, never inside
// it (the journal is an append-only record of what happened; "a gate is
// waiting right now" is present-tense process state).
//
// Two files make a gate answerable from a DIFFERENT process than the one
// running the loop (a detached run, or a `run --ui` process viewed from a
// separate long-lived `ui --all` mission control):
//
//   gate-waiting.json - written by the run's own gate handler the instant
//     it starts waiting, removed the instant it settles. Any dashboard
//     process reading this run directory can see a gate is pending and ask.
//   gate-answer.json  - written by a dashboard process to answer that gate;
//     the waiting gate handler polls for it, consumes it (read + delete in
//     one step), and resolves with it.
//
// Lives in the journal layer so both cli/ (the writer/poller) and
// dashboard/ (the reader/answerer) can import it without a cycle.

export interface GateWaitingMarker {
  nodeId: string
  isPlanApproval: boolean
  question: string
}

function gateWaitingPath(runDir: string): string {
  return join(runDir, 'gate-waiting.json')
}

export function writeGateWaitingMarker(runDir: string, marker: GateWaitingMarker): void {
  try {
    writeFileSync(gateWaitingPath(runDir), JSON.stringify(marker))
  } catch {
    // swallowed - a run must never fail just because it couldn't record this
  }
}

export function removeGateWaitingMarker(runDir: string): void {
  try {
    unlinkSync(gateWaitingPath(runDir))
  } catch {
    // swallowed - already gone, or never written; either way nothing to clean up
  }
}

export function readGateWaitingMarker(runDir: string): GateWaitingMarker | undefined {
  try {
    return JSON.parse(readFileSync(gateWaitingPath(runDir), 'utf8')) as GateWaitingMarker
  } catch {
    return undefined
  }
}

export function gateAnswerPath(runDir: string): string {
  return join(runDir, 'gate-answer.json')
}

export function writeGateAnswer(runDir: string, answer: GateAnswer): void {
  writeFileSync(gateAnswerPath(runDir), JSON.stringify(answer))
}

// Read + delete in one step, so an answer is applied exactly once. Returns
// undefined when there is no answer yet (the poller's steady state), when
// the JSON is unreadable, or when the shape is wrong (a file some other
// tool dropped there must never approve a gate by accident).
export function consumeGateAnswer(runDir: string): GateAnswer | undefined {
  const p = gateAnswerPath(runDir)
  let raw: string
  try {
    raw = readFileSync(p, 'utf8')
  } catch {
    return undefined
  }
  try {
    unlinkSync(p)
  } catch {
    // another consumer won the race - treat as no answer for this one
    return undefined
  }
  try {
    const parsed = JSON.parse(raw) as GateAnswer
    if (typeof parsed?.approved !== 'boolean') return undefined
    return { approved: parsed.approved, ...(typeof parsed.feedback === 'string' ? { feedback: parsed.feedback } : {}) }
  } catch {
    return undefined
  }
}

// Called by a gate handler BEFORE it starts waiting: an answer file already
// on disk was aimed at some EARLIER gate (or is debris from a killed run) -
// letting it instantly approve a brand-new gate the human never saw would
// be an auto-approval bug, not a convenience.
export function discardStaleGateAnswer(runDir: string): void {
  try {
    unlinkSync(gateAnswerPath(runDir))
  } catch {
    // nothing stale - the common case
  }
}
