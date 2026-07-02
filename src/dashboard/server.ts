import { existsSync, readFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
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

const PAGE = buildPage() // static — built once per process, not per request

function readEvents(journalPath: string) {
  return existsSync(journalPath) ? readJournal(journalPath) : []
}

export function startDashboardServer(opts: DashboardServerOptions): Promise<DashboardServer> {
  const watch = opts.watcher ?? fsWatcher

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')

    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(PAGE)
      return
    }

    if (req.method === 'GET' && url.pathname === '/model') {
      const payload = buildDashboardPayload(readEvents(opts.journalPath), opts.def)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(payload))
      return
    }

    if (req.method === 'GET' && url.pathname === '/events') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      })
      res.write(buildReplay(readEvents(opts.journalPath)))
      res.on('error', () => {}) // client disconnects mid-write are not server errors
      let offset = existsSync(opts.journalPath) ? readFileSync(opts.journalPath, 'utf8').length : 0
      // The journal file may not exist yet (run hasn't written its first
      // line). Node's real fs.watch() throws synchronously with ENOENT for
      // a nonexistent path, which would otherwise crash the whole process.
      // Watch the parent directory instead — it exists, and fs.watch on a
      // directory fires for changes to files created/modified inside it —
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
            // mid-stream) — log and skip; never let this take down the process.
            console.error('dashboard /events: failed to read journal update', err)
          }
        })
      } catch (err) {
        console.error('dashboard /events: failed to start watcher', err)
      }
      req.on('close', () => handle?.close())
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
