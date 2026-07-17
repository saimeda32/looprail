import type { JournalEvent, LoopDef } from '../core/types.js'
import { dim, err, ok, warn } from './ui.js'

// Live in-place run rendering for a real terminal: one status block that
// updates in place (spinner on the running node, live cost ticker) instead
// of an append-only scroll - the build-tool feel. Active only on a TTY and
// never in --json; everywhere else the classic line-per-event output is
// untouched, byte for byte.
//
// Design keeps the untestable part thin: a pure state + render core
// (unit-tested) and a shell that owns the redraw timer and ANSI erase. The
// block must never fight other writers for the screen, so anything else
// that needs the terminal mid-run (a gate card + its readline prompt)
// PAUSES the renderer - the block is finalized in place, the gate scrolls
// below it, and a fresh block starts on resume.

const ESC = '\u001b'
const SPINNER = ['|', '/', '-', '\\']

export interface NodeRow {
  id: string
  role: string
  status: 'running' | 'pass' | 'fail' | 'error' | 'done' | 'skipped'
  costUsd: number
  startedAt: number
  endedAt?: number
}

export interface LiveState {
  iteration: number
  costUsd: number
  maxCostUsd: number
  rows: NodeRow[] // in first-start order; a re-running node updates its row
}

export function applyEvent(state: LiveState, e: JournalEvent, now: number): LiveState {
  const d = e.data as Record<string, unknown>
  if (e.type === 'node_start') {
    const id = String(d.nodeId)
    const rows = state.rows.some((r) => r.id === id)
      ? state.rows.map((r) => r.id === id
        ? { ...r, status: 'running' as const, startedAt: now, endedAt: undefined, costUsd: r.costUsd }
        : r)
      : [...state.rows, { id, role: String(d.role), status: 'running' as const, costUsd: 0, startedAt: now }]
    return { ...state, iteration: Number(d.iteration ?? state.iteration), rows }
  }
  if (e.type === 'node_end') {
    const id = String(d.nodeId)
    const v = d.verdict as { status?: string } | null
    const status: NodeRow['status'] = !v ? 'done'
      : v.status === 'pass' ? 'pass'
        : v.status === 'error' ? 'error' : 'fail'
    const cost = Number(d.costUsd ?? 0) + Number(d.estimatedCostUsd ?? 0)
    return {
      ...state,
      costUsd: state.costUsd + cost,
      rows: state.rows.map((r) => r.id === id ? { ...r, status, costUsd: r.costUsd + cost, endedAt: now } : r),
    }
  }
  if (e.type === 'node_skipped') {
    const id = String(d.nodeId)
    if (state.rows.some((r) => r.id === id)) {
      return { ...state, rows: state.rows.map((r) => r.id === id ? { ...r, status: 'skipped' as const } : r) }
    }
    return { ...state, rows: [...state.rows, { id, role: '', status: 'skipped', costUsd: 0, startedAt: now, endedAt: now }] }
  }
  if (e.type === 'iteration_end') {
    return { ...state, iteration: Number(d.iteration ?? state.iteration) }
  }
  return state
}

const GLYPH: Record<NodeRow['status'], (s: string) => string> = {
  running: (s) => ok(s),
  pass: () => ok('+'),
  done: () => ok('+'),
  fail: () => err('x'),
  error: () => err('!'),
  skipped: () => dim('-'),
}

export function renderLive(state: LiveState, now: number, tick: number): string[] {
  const spin = SPINNER[tick % SPINNER.length]
  const running = state.rows.filter((r) => r.status === 'running').length
  const header = `${ok(spin)} iter ${state.iteration} ${dim('|')} $${state.costUsd.toFixed(2)} / $${state.maxCostUsd} ${dim('|')} ${running > 0 ? `${running} running` : 'settling'}`
  const width = Math.max(...state.rows.map((r) => r.id.length), 8)
  const lines = [header]
  for (const r of state.rows) {
    const glyph = r.status === 'running' ? GLYPH.running(spin) : GLYPH[r.status]('')
    const elapsed = r.status === 'running' ? dim(` ${Math.max(0, Math.round((now - r.startedAt) / 1000))}s`) : ''
    const cost = r.costUsd > 0 ? dim(` $${r.costUsd.toFixed(2)}`) : ''
    lines.push(`  ${glyph} ${r.id.padEnd(width)} ${dim(r.role.padEnd(11))}${cost}${elapsed}`)
  }
  return lines
}

// The shell: owns the timer and in-place redraw. `pause()` freezes the block
// where it stands (so a gate prompt can scroll below); `resume()` starts a
// fresh block. `finish()` stops for good, leaving the last block on screen.
export class LiveRunRenderer {
  private state: LiveState
  private tick = 0
  private lastLineCount = 0
  private timer: ReturnType<typeof setInterval> | undefined
  private paused = false

  constructor(def: LoopDef, private stdout: NodeJS.WriteStream, private now: () => number = Date.now) {
    this.state = { iteration: 0, costUsd: 0, maxCostUsd: def.rails.maxCostUsd, rows: [] }
  }

  start(): void {
    this.timer = setInterval(() => { this.tick += 1; this.draw() }, 120)
    this.timer.unref?.()
  }

  onEvent(e: JournalEvent): void {
    this.state = applyEvent(this.state, e, this.now())
    if (e.type === 'replan') {
      // replans are rare and worth a scrolled line even in live mode
      this.interject(warn(`  replan #${String((e.data as Record<string, unknown>).replans)}`))
      return
    }
    if (!this.paused) this.draw()
  }

  // Print a line that should SCROLL (survive) above the live block.
  interject(line: string): void {
    this.erase()
    this.stdout.write(line + String.fromCharCode(10))
    this.draw()
  }

  pause(): void {
    if (this.paused) return
    this.paused = true
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    // leave the current block printed; subsequent output scrolls below it
    this.lastLineCount = 0
  }

  resume(): void {
    if (!this.paused) return
    this.paused = false
    this.start()
    this.draw()
  }

  finish(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    this.draw() // final state, spinner settled
    this.lastLineCount = 0
  }

  private erase(): void {
    if (this.lastLineCount > 0) {
      this.stdout.write(`${ESC}[${this.lastLineCount}A${ESC}[0J`)
      this.lastLineCount = 0
    }
  }

  private draw(): void {
    if (this.paused) return
    const lines = renderLive(this.state, this.now(), this.tick)
    this.erase()
    for (const line of lines) this.stdout.write(line + String.fromCharCode(10))
    this.lastLineCount = lines.length
  }
}
