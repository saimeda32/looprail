import { existsSync, readFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
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
      let offset = existsSync(opts.journalPath) ? readFileSync(opts.journalPath, 'utf8').length : 0
      const handle = watch(opts.journalPath, () => {
        const { events, offset: next } = readNewEvents(opts.journalPath, offset)
        offset = next
        for (const event of events) res.write(encodeSseFrame(event))
      })
      req.on('close', () => handle.close())
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
