import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { dirname, join } from 'node:path'
import type { LoopDef } from '../core/types.js'
import { readJournal } from '../journal/journal.js'
import { buildDashboardPayload } from './layout.js'
import { buildPage } from './page.js'
import { buildReplay, encodeSseFrame } from './sse.js'
import { fsWatcher, readNewEvents, type Watcher } from './tail.js'

export interface DashboardServerOptions {
  journalPath: string
  def?: LoopDef
  watcher?: Watcher
}

export interface DashboardServer {
  server: Server
  url: string
  close(): Promise<void>
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

// The three per-run route handlers, extracted verbatim from what was
// startDashboardServer's single request handler before mission control
// (Plan 3b) needed to mount the exact same per-run view under a
// /run/<workspaceHash>/<runId>/... prefix too. Nothing about their behavior
// changed in the extraction - same status codes, same headers, same
// TOCTOU-safe error handling, same ENOENT-safe watch-the-parent-dir
// fallback - so startDashboardServer's own request handler below, and its
// existing tests, are unaffected byte-for-byte. mission-control-server.ts
// (Task 10) imports these same three functions instead of reimplementing
// per-run routing.
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
function controlState(
  journalPath: string,
): { controllable: boolean; paused: boolean; pauseUnsafe: boolean } {
  const runDir = dirname(journalPath)
  const pidPath = join(runDir, 'pid')
  const controllable = existsSync(pidPath)
  // See serveControl's own comment on the same check: pausing the process
  // that is serving this exact dashboard (looprail run --ui) freezes the
  // server answering this very request, with no way to resume from inside
  // it. The client uses this to grey out Pause specifically, not the whole
  // control set - Cancel stays safe and available either way.
  const pauseUnsafe = controllable && Number(readFileSync(pidPath, 'utf8').trim()) === process.pid
  return { controllable, paused: existsSync(join(runDir, 'paused')), pauseUnsafe }
}

export function serveModel(res: ServerResponse, opts: { journalPath: string; def?: LoopDef }): void {
  try {
    const payload = buildDashboardPayload(readEvents(opts.journalPath), opts.def)
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ...payload, ...controlState(opts.journalPath) }))
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

// Pause/resume/cancel a run's own process - scoped strictly to runs looprail
// itself started and recorded a pid for (run-cmd.ts writes <runDir>/pid on
// startup); there is no path from here to any other process on the machine.
// A run's own reported status is the safety gate against a stale or reused
// pid: once a run's journal shows verified/halted, this refuses to signal
// anything at all, regardless of what the pid file still says.
export async function serveControl(
  req: IncomingMessage, res: ServerResponse, opts: { journalPath: string },
): Promise<void> {
  let action: string | undefined
  try {
    const body = await readRequestBody(req)
    action = (JSON.parse(body || '{}') as { action?: string }).action
  } catch {
    sendJson(res, 400, { error: 'invalid request body' })
    return
  }
  if (action !== 'pause' && action !== 'resume' && action !== 'cancel') {
    sendJson(res, 400, { error: `unknown action "${String(action)}"` })
    return
  }

  let status: string
  try {
    status = buildDashboardPayload(readEvents(opts.journalPath)).status
  } catch (err) {
    sendReadError(res, '/control failed to read journal', err)
    return
  }
  if (status !== 'running') {
    sendJson(res, 409, { error: `run is ${status}, not running - nothing to ${action}` })
    return
  }

  const runDir = dirname(opts.journalPath)
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

export function startDashboardServer(opts: DashboardServerOptions): Promise<DashboardServer> {
  const watch = opts.watcher ?? fsWatcher

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')

    if (req.method === 'GET' && url.pathname === '/') {
      serveIndexPage(res)
      return
    }

    if (req.method === 'GET' && url.pathname === '/model') {
      serveModel(res, opts)
      return
    }

    if (req.method === 'GET' && url.pathname === '/events') {
      serveEvents(req, res, opts, watch)
      return
    }

    if (req.method === 'POST' && url.pathname === '/control') {
      void serveControl(req, res, opts)
      return
    }

    res.writeHead(404, { 'content-type': 'text/plain' })
    res.end('not found')
  })

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      const port = addr && typeof addr === 'object' ? addr.port : 0
      resolve({
        server,
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise((res) => server.close(() => res())),
      })
    })
  })
}
