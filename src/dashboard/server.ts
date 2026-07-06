import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { dirname, join } from 'node:path'
import type { GateAnswer, LoopDef } from '../core/types.js'
import { readJournal } from '../journal/journal.js'
import { queueHumanFeedback } from '../journal/human-feedback.js'
import {
  getPendingGate as defaultGetPendingGate, resolvePendingGate as defaultResolvePendingGate, type PendingGate,
} from './gate-registry.js'
import {
  getPendingPermission as defaultGetPendingPermission,
  resolvePendingPermission as defaultResolvePendingPermission,
  type PendingPermission,
} from './permission-registry.js'
import { readGateWaitingMarker, writeGateAnswer } from '../journal/gate-files.js'
import { buildDashboardPayload } from './layout.js'
import { buildPage } from './page.js'
import { buildReplay, encodeSseFrame } from './sse.js'
import { readNewEvents, type Watcher } from './tail.js'

export interface ResumeOverrides {
  maxIterations?: number
  maxCostUsd?: number
  maxWallMinutes?: number
  replanLimit?: number
  goal?: string
}

const PAGE = buildPage() // static - built once per process, not per request

function readEvents(journalPath: string) {
  return existsSync(journalPath) ? readJournal(journalPath) : []
}

function readLength(journalPath: string): number {
  return existsSync(journalPath) ? readFileSync(journalPath, 'utf8').length : 0
}

// A filesystem read can throw for reasons outside our control: the journal
// path gets deleted between an existsSync check and the read (TOCTOU), a
// permissions error, or the path turning out to be a directory. Whatever the
// cause, a synchronous throw inside a request handler becomes an uncaught
// exception that crashes the whole process - so every route that touches the
// journal on disk funnels its error handling through this one helper.
function sendReadError(res: ServerResponse, context: string, err: unknown): void {
  console.error(`dashboard: ${context}`, err)
  if (!res.headersSent) {
    res.writeHead(500, { 'content-type': 'text/plain' })
    res.end('failed to read journal')
  } else {
    res.end()
  }
}

// The three per-run route handlers - the only production code left in this
// module. A second, separately-maintained request handler used to live
// below (startDashboardServer), one that `looprail run --ui` wired up on
// its own and never re-read a run's persisted loopfile.json after startup,
// which is exactly how it drifted out of sync with mission-control-
// server.ts's own per-run routing (which DOES re-read it on every
// request). That duplicate implementation has been deleted: every CLI
// entrypoint (`run --ui`, `ui <runId>`, `ui --all`) now starts
// mission-control-server.ts's startMissionControlServer, which imports
// these same functions instead of reimplementing per-run routing - there
// is exactly one dashboard server, and this file only supplies its shared
// route handlers.
export function serveIndexPage(res: ServerResponse): void {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  res.end(PAGE)
}

// A run's own process id (recorded by run-cmd.ts as it starts) and a
// pause marker (written/removed by serveControl below) both live next to
// its journal, not inside it - they describe the OS process, not the loop's
// own history, so they do not belong in the journal or in buildViewModel's
// pure event-derived model. The dashboard client only needs to know
// whether controls apply at all (pid), whether the paused marker is
// currently present, and whether pausing is even safe to offer - not the
// raw pid value itself.
// A pid FILE existing is not the same as the process it names still being
// alive - real bug caught live: a run killed with SIGKILL (bypassing its
// own SIGTERM handler, which is what normally removes the pid file on a
// graceful stop) leaves an orphaned pid file behind forever, and the
// dashboard kept reporting that dead run as controllable indefinitely.
// process.kill(pid, 0) sends no real signal - it only probes whether the
// pid is a live process this user can signal, throwing ESRCH if it is not.
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

// The run's own process is alive, per its pid file (orphaned pid files from
// force-killed runs read as dead - see isProcessAlive above). Used both for
// controllable state and to decide whether a gate-waiting marker written by
// ANOTHER process is live (answerable via the answer file) or debris left
// by a dead run.
function runProcessAlive(runDir: string): boolean {
  const pidPath = join(runDir, 'pid')
  const pid = existsSync(pidPath) ? Number(readFileSync(pidPath, 'utf8').trim()) : undefined
  return pid !== undefined && isProcessAlive(pid)
}

function controlState(
  journalPath: string, resumable: boolean,
): { controllable: boolean; paused: boolean; pauseUnsafe: boolean; resumable: boolean } {
  const runDir = dirname(journalPath)
  const pidPath = join(runDir, 'pid')
  const pid = existsSync(pidPath) ? Number(readFileSync(pidPath, 'utf8').trim()) : undefined
  const controllable = pid !== undefined && isProcessAlive(pid)
  // See serveControl's own comment on the same check: pausing the process
  // that is serving this exact dashboard (looprail run --ui) freezes the
  // server answering this very request, with no way to resume from inside
  // it. The client uses this to grey out Pause specifically, not the whole
  // control set - Cancel stays safe and available either way.
  const pauseUnsafe = controllable && pid === process.pid
  return { controllable, paused: existsSync(join(runDir, 'paused')), pauseUnsafe, resumable }
}

export function serveModel(
  res: ServerResponse,
  opts: {
    journalPath: string
    def?: LoopDef
    onResume?: (overrides: ResumeOverrides) => Promise<void>
    getPendingGate?: (runId: string) => PendingGate | undefined
  },
): void {
  try {
    // payload.totals.maxIterations/maxCostUsd already carry the run's own
    // rails (view-model.ts derives them from the same def) - the resume
    // form prefills from those, nothing extra to compute here.
    const payload = buildDashboardPayload(readEvents(opts.journalPath), opts.def)
    // Canceling is a deliberate "stop this" action, not a rail-breach halt -
    // it's not resumable. Someone who wants to continue starts a fresh run.
    const resumable = payload.status === 'halted' && !!opts.onResume
    // Whether a gate is CURRENTLY waiting for a human answer is engine/
    // registry state, not journal-derived (buildViewModel is pure and has
    // no "gate is waiting" event - see journal/gate-files.ts for the full
    // rationale) - so it is looked up separately here and merged into the
    // /model payload the same way controlState already is. Two sources, in
    // order: this process's own in-memory registry (the run lives HERE -
    // `run --ui`), then the run directory's gate-waiting marker, honored
    // only while the run's process is actually alive (a marker left behind
    // by a dead process must not render a phantom approval prompt). The
    // marker is what makes a DETACHED run's gate - or a `run --ui` gate
    // viewed from a separate long-lived mission control - visible at all.
    const pending = (opts.getPendingGate ?? defaultGetPendingGate)(payload.runId)
    const runDir = dirname(opts.journalPath)
    const marker = pending ? undefined : readGateWaitingMarker(runDir)
    const markerLive = marker !== undefined && runProcessAlive(runDir)
    // question included so the approval UI can show WHAT is being approved
    // right next to the approve button - previously the human had to hunt
    // for the content elsewhere on the page before deciding.
    const pendingGate = pending
      ? { nodeId: pending.nodeId, isPlanApproval: pending.isPlanApproval, question: pending.question }
      : markerLive ? { nodeId: marker.nodeId, isPlanApproval: marker.isPlanApproval, question: marker.question } : null
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ...payload, ...controlState(opts.journalPath, resumable), pendingGate }))
  } catch (err) {
    sendReadError(res, '/model failed to read journal', err)
  }
}

function readRequestBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = ''
    req.on('data', (chunk: Buffer) => { body += chunk })
    req.on('end', () => resolve(body))
    req.on('error', reject)
  })
}

const CONTROL_SIGNALS = { pause: 'SIGSTOP', resume: 'SIGCONT', cancel: 'SIGTERM' } as const
type ControlAction = keyof typeof CONTROL_SIGNALS

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

// This endpoint pauses, resumes, or kills a real process - reachable by any
// page open in the same browser, not just this dashboard's own tab, since
// browsers do not scope a fetch() to "only pages the user meant to load
// this from." A malicious site the user has open in another tab could
// otherwise POST here blind (no response needed, no user interaction) and
// cancel or pause a run just by knowing it runs on localhost - a classic
// CSRF pattern that plain content-type checking does not fully close (a
// text/plain form POST needs no CORS preflight at all). Reject any request
// whose Origin (or, failing that, Referer) does not match the host this
// server itself is answering as; allow requests with neither header, since
// a real browser CSRF attempt always sends at least one and a bare
// script/curl call from the user's own terminal has no ambient session to
// forge in the first place.
function isSameOrigin(req: IncomingMessage): boolean {
  const host = req.headers.host
  if (!host) return false
  const origin = req.headers.origin
  if (origin) return origin === `http://${host}`
  const referer = req.headers.referer
  if (referer) return referer === `http://${host}` || referer.startsWith(`http://${host}/`)
  return true
}

// Pause/resume/cancel a run's own process - scoped strictly to runs looprail
// itself started and recorded a pid for (run-cmd.ts writes <runDir>/pid on
// startup); there is no path from here to any other process on the machine.
// A run's own reported status is the safety gate against a stale or reused
// pid: once a run's journal shows verified/halted, this refuses to signal
// anything at all, regardless of what the pid file still says.
export async function serveControl(
  req: IncomingMessage, res: ServerResponse,
  opts: {
    journalPath: string
    getPendingGate?: (runId: string) => PendingGate | undefined
    resolvePendingGate?: (runId: string, nodeId: string, answer: GateAnswer) => boolean
    // Same wiring rationale as getPendingGate/resolvePendingGate above, but
    // backed by the SEPARATE mid-node registry in permission-registry.ts
    // (see that file's header comment for why the two must not be
    // conflated) - a `looprail run --ui` process wires this to its real,
    // process-lifetime Map "for free"; tests inject their own fake store.
    getPendingPermission?: (runId: string) => PendingPermission | undefined
    resolvePendingPermission?: (runId: string, nodeId: string, answer: string) => boolean
  },
): Promise<void> {
  if (!isSameOrigin(req)) {
    sendJson(res, 403, { error: 'cross-origin request rejected' })
    return
  }
  let action: string | undefined
  let text: string | undefined
  let nodeId: string | undefined
  let approved: boolean | undefined
  try {
    const body = await readRequestBody(req)
    const parsed = JSON.parse(body || '{}') as { action?: string; text?: string; nodeId?: string; approved?: boolean }
    action = parsed.action
    text = parsed.text
    nodeId = parsed.nodeId
    approved = parsed.approved
  } catch {
    sendJson(res, 400, { error: 'invalid request body' })
    return
  }
  if (
    action !== 'pause' && action !== 'resume' && action !== 'cancel' && action !== 'feedback'
    && action !== 'approve-gate' && action !== 'reject-gate' && action !== 'answer-permission'
  ) {
    sendJson(res, 400, { error: `unknown action "${String(action)}"` })
    return
  }
  if (action === 'reject-gate' && (typeof text !== 'string' || text.trim().length === 0)) {
    sendJson(res, 400, { error: 'reject-gate requires a non-empty feedback text' })
    return
  }
  if (action === 'answer-permission' && (typeof nodeId !== 'string' || nodeId.trim().length === 0)) {
    sendJson(res, 400, { error: 'answer-permission requires a non-empty nodeId' })
    return
  }
  if (action === 'answer-permission' && typeof approved !== 'boolean') {
    sendJson(res, 400, { error: 'answer-permission requires a boolean approved field' })
    return
  }

  let runId: string
  let status: string
  try {
    const payload = buildDashboardPayload(readEvents(opts.journalPath))
    runId = payload.runId
    status = payload.status
  } catch (err) {
    sendReadError(res, '/control failed to read journal', err)
    return
  }
  if (status !== 'running') {
    sendJson(res, 409, { error: `run is ${status}, not running - nothing to ${action}` })
    return
  }

  // Approves or rejects (with the mandatory free-text feedback) whichever
  // gate is currently blocking this run's own process - looked up via the
  // exact same in-process registry makeUiGate (src/cli/run-cmd.ts) races its
  // stdin question against (src/dashboard/gate-registry.ts). The resolved
  // GateAnswer flows through the identical normalizeGateAnswer path a
  // CLI/MCP answer already does downstream - there is no second, parallel
  // approval mechanism here, only a different way to produce the same
  // GateAnswer value.
  if (action === 'approve-gate' || action === 'reject-gate') {
    const getPending = opts.getPendingGate ?? defaultGetPendingGate
    const resolvePending = opts.resolvePendingGate ?? defaultResolvePendingGate
    const answer: GateAnswer = action === 'approve-gate'
      ? { approved: true }
      : { approved: false, feedback: text as string }
    const pending = getPending(runId)
    if (pending) {
      resolvePending(runId, pending.nodeId, answer)
      sendJson(res, 200, { ok: true })
      return
    }
    // Cross-process fallback: the run lives in a DIFFERENT process than
    // this dashboard (a detached `run -d`, or a `run --ui` process viewed
    // from a separate long-lived mission control) - its in-process registry
    // is unreachable from here. Its gate handler polls the run directory
    // for an answer file instead (journal/gate-files.ts), so the answer is
    // delivered by writing that file. Honored only while the run's process
    // is actually alive: answering a dead run's leftover marker would strand
    // an answer file on disk to mis-approve some future gate.
    const runDir = dirname(opts.journalPath)
    const marker = readGateWaitingMarker(runDir)
    if (marker && runProcessAlive(runDir)) {
      writeGateAnswer(runDir, answer)
      sendJson(res, 200, { ok: true })
      return
    }
    sendJson(res, 409, { error: 'no gate is currently waiting for this run' })
    return
  }

  // Answers a mid-node agent-CLI permission prompt currently blocking ONE
  // node's own subprocess - looked up (and resolved) via dashboard/
  // permission-registry.ts, deliberately NOT gate-registry.ts (see that
  // file's own header comment for why the two are not the same mechanism).
  // Unlike a gate, more than one node's prompt could be pending in the
  // same run at once, so nodeId is required in the body rather than
  // inferred from "the one gate this run has". The raw answer string
  // handed to resolvePendingPermission is built to survive the exact
  // parsing engine/runner.ts's parsePermissionAnswer does downstream:
  // approved -> 'y', rejected -> the feedback text verbatim (or an empty
  // string when no feedback was given, which parsePermissionAnswer reads
  // as a plain, feedback-less rejection).
  if (action === 'answer-permission') {
    const getPending = opts.getPendingPermission ?? defaultGetPendingPermission
    const resolvePending = opts.resolvePendingPermission ?? defaultResolvePendingPermission
    const pending = getPending(runId)
    if (!pending || pending.nodeId !== nodeId) {
      sendJson(res, 409, { error: 'no permission is currently waiting for this node' })
      return
    }
    const answer = approved ? 'y' : (text ?? '')
    resolvePending(runId, nodeId as string, answer)
    sendJson(res, 200, { ok: true })
    return
  }

  const runDir = dirname(opts.journalPath)

  // A human's note for the executor's next attempt - pure file drop, no
  // pid or OS signal involved (runner.ts polls for it at the top of each
  // iteration), so it works identically whether this dashboard is the
  // run's own process or a separate viewer/mission-control watching it.
  if (action === 'feedback') {
    if (typeof text !== 'string' || text.trim().length === 0) {
      sendJson(res, 400, { error: 'feedback text must be a non-empty string' })
      return
    }
    queueHumanFeedback(runDir, text)
    sendJson(res, 200, { ok: true })
    return
  }

  const pidPath = join(runDir, 'pid')
  if (!existsSync(pidPath)) {
    sendJson(res, 404, { error: 'no recorded process for this run' })
    return
  }
  const pid = Number(readFileSync(pidPath, 'utf8').trim())

  // `looprail run --ui` serves this exact dashboard from inside the run's
  // own process. SIGSTOP has no app-level handler - the kernel freezes the
  // whole process, including the HTTP server answering this very request,
  // with nothing left able to accept the eventual "resume" click. Verified
  // empirically: paused this way, the dashboard stops answering ANY request
  // at all, not just this one - there is no recovery from inside it.
  // Refuse specifically the action that creates that trap; cancel (SIGTERM)
  // has a real handler (run-cmd.ts's installCancelHandler) that finishes
  // writing this very response before the process exits on its own terms,
  // so it stays safe to self-target.
  if (pid === process.pid && action === 'pause') {
    sendJson(res, 400, {
      error: 'cannot pause the process serving this dashboard - it would freeze the '
        + 'dashboard itself with no way to resume from here. Open this run from '
        + '`looprail ui --all` instead, which runs as a separate process and can '
        + 'safely pause and resume it.',
    })
    return
  }

  try {
    process.kill(pid, CONTROL_SIGNALS[action as ControlAction])
  } catch {
    sendJson(res, 409, { error: 'process is no longer running' })
    return
  }
  const pausedMarker = join(runDir, 'paused')
  if (action === 'pause') {
    writeFileSync(pausedMarker, '')
  } else {
    try { unlinkSync(pausedMarker) } catch { /* was not paused */ }
  }
  sendJson(res, 200, { ok: true })
}

function isPositiveFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0
}

// Continues a halted run in place - the runId and journal stay the same
// (see cli/resume-cmd.ts's resumeAction, which opts.onResume wraps), so
// unlike serveControl there is no pid to check: a halted run's process has
// already exited, resuming means starting a new one, not signaling an old
// one. Responds as soon as the request is validated and handed off, not
// once the whole continued run finishes - the browser watches it progress
// the same way it watches any other live run, through /model and /events.
export async function serveResume(
  req: IncomingMessage, res: ServerResponse,
  opts: { journalPath: string; onResume?: (overrides: ResumeOverrides) => Promise<void> },
): Promise<void> {
  if (!isSameOrigin(req)) {
    sendJson(res, 403, { error: 'cross-origin request rejected' })
    return
  }
  if (!opts.onResume) {
    sendJson(res, 501, { error: 'this dashboard has no way to resume this run (no loopfile found for its workspace)' })
    return
  }
  let overrides: ResumeOverrides
  try {
    const body = await readRequestBody(req)
    const parsed = JSON.parse(body || '{}') as { maxIterations?: unknown; maxCostUsd?: unknown; maxWallMinutes?: unknown; replanLimit?: unknown; goal?: unknown }
    if (parsed.maxIterations !== undefined && !isPositiveFiniteNumber(parsed.maxIterations)) {
      sendJson(res, 400, { error: 'maxIterations must be a positive number' })
      return
    }
    if (parsed.maxCostUsd !== undefined && !isPositiveFiniteNumber(parsed.maxCostUsd)) {
      sendJson(res, 400, { error: 'maxCostUsd must be a positive number' })
      return
    }
    if (parsed.maxWallMinutes !== undefined && !isPositiveFiniteNumber(parsed.maxWallMinutes)) {
      sendJson(res, 400, { error: 'maxWallMinutes must be a positive number' })
      return
    }
    if (parsed.replanLimit !== undefined && !isPositiveFiniteNumber(parsed.replanLimit)) {
      sendJson(res, 400, { error: 'replanLimit must be a positive number' })
      return
    }
    // Goal-only override (GAP 2): a non-empty string when provided. Threaded
    // through the same override path as the rails so the resumed run picks it
    // up without ever mutating the user's loopfile.yaml on disk.
    if (parsed.goal !== undefined && (typeof parsed.goal !== 'string' || parsed.goal.trim().length === 0)) {
      sendJson(res, 400, { error: 'goal must be a non-empty string' })
      return
    }
    overrides = {
      maxIterations: parsed.maxIterations as number | undefined,
      maxCostUsd: parsed.maxCostUsd as number | undefined,
      maxWallMinutes: parsed.maxWallMinutes as number | undefined,
      replanLimit: parsed.replanLimit as number | undefined,
      goal: parsed.goal as string | undefined,
    }
  } catch {
    sendJson(res, 400, { error: 'invalid request body' })
    return
  }

  let status: string
  try {
    status = buildDashboardPayload(readEvents(opts.journalPath)).status
  } catch (err) {
    sendReadError(res, '/resume failed to read journal', err)
    return
  }
  if (status !== 'halted') {
    sendJson(res, 409, { error: `run is ${status}, not halted - nothing to resume` })
    return
  }

  sendJson(res, 200, { ok: true })
  opts.onResume(overrides).catch((err: unknown) => {
    console.error('dashboard: resume failed', err)
  })
}

export function serveEvents(
  req: IncomingMessage, res: ServerResponse, opts: { journalPath: string }, watch: Watcher,
): void {
  // Read the replay data and starting offset BEFORE writing any response
  // headers, so a read failure here (deleted file, permissions, a path
  // that turns out to be a directory) can still be answered with a clean
  // 500 instead of crashing mid-stream.
  let replay: string
  let offset: number
  try {
    replay = buildReplay(readEvents(opts.journalPath))
    offset = readLength(opts.journalPath)
  } catch (err) {
    sendReadError(res, '/events failed to read journal', err)
    return
  }
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  })
  res.write(replay)
  res.on('error', () => {}) // client disconnects mid-write are not server errors
  // The journal file may not exist yet (run hasn't written its first
  // line). Node's real fs.watch() throws synchronously with ENOENT for
  // a nonexistent path, which would otherwise crash the whole process.
  // Watch the parent directory instead - it exists, and fs.watch on a
  // directory fires for changes to files created/modified inside it - 
  // so we still get notified once the journal appears, without ever
  // handing a nonexistent path to watch().
  const watchTarget = existsSync(opts.journalPath) ? opts.journalPath : dirname(opts.journalPath)
  let handle: { close(): void } | undefined
  try {
    handle = watch(watchTarget, () => {
      try {
        const { events, offset: next } = readNewEvents(opts.journalPath, offset)
        offset = next
        for (const event of events) res.write(encodeSseFrame(event))
      } catch (err) {
        // Journal not readable this tick (not created yet, or deleted
        // mid-stream) - log and skip; never let this take down the process.
        console.error('dashboard /events: failed to read journal update', err)
      }
    })
  } catch (err) {
    console.error('dashboard /events: failed to start watcher', err)
  }
  req.on('close', () => handle?.close())
}
