import { existsSync, readFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { dirname } from 'node:path'
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

export function serveModel(res: ServerResponse, opts: { journalPath: string; def?: LoopDef }): void {
  try {
    const payload = buildDashboardPayload(readEvents(opts.journalPath), opts.def)
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(payload))
  } catch (err) {
    sendReadError(res, '/model failed to read journal', err)
  }
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
