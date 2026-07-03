import { existsSync, readFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { join, resolve } from 'node:path'
import { expandPanels, parseLoopfile, validateGraph, type LoopDef } from '../index.js'
import {
  discoverClaudeCodeSessions, discoverRuns, runsRootOf, workspaceHash,
  type RunListEntry, type SessionEntry,
} from '../workspace/discover.js'
import { defaultRegistryPath, listWorkspaces } from '../workspace/registry.js'
import { buildMissionControlPage } from './mission-control-page.js'
import { serveEvents, serveIndexPage, serveModel } from './server.js'
import { fsWatcher, type Watcher } from './tail.js'

// See discover.ts (Task 8) for why this is a small, deliberate duplicate of
// loadExpandedLoopDef (src/cli/ui-cmd.ts) rather than an import of it.
function bestEffortLoopDef(workspace: string): LoopDef | undefined {
  try {
    const path = resolve(workspace, 'looprail.yaml')
    if (!existsSync(path)) return undefined
    const def = parseLoopfile(readFileSync(path, 'utf8'))
    if (validateGraph(def).length > 0) return undefined
    const expanded = expandPanels(def)
    return validateGraph(expanded).length > 0 ? undefined : expanded
  } catch {
    return undefined
  }
}

export type Poller = (fn: () => void, intervalMs: number) => { close(): void }

// Real production poller: a plain, unref'd setInterval. This is the one
// place in the whole dashboard/mission-control tree production code starts
// a timer of its own accord — everything else reacts to fs.watch or an
// incoming request. It exists only to notice OTHER processes' runs
// progressing (a `looprail run` in another terminal, writing to a journal
// this server never individually subscribed to) between one full re-scan
// and the next. Tests never touch it — see mission-control-server.test.ts,
// which always injects a manually-triggered fake (design decision 9).
export const intervalPoller: Poller = (fn, intervalMs) => {
  const handle = setInterval(fn, intervalMs)
  handle.unref()
  return { close: () => clearInterval(handle) }
}

// Pure: whether a fresh JSON snapshot differs from the last one sent, and so
// should trigger a new SSE frame.
export function snapshotChanged(previous: string, next: string): boolean {
  return previous !== next
}

export interface ScanResult { runs: RunListEntry[]; sessions: SessionEntry[] }

export interface MissionControlServerOptions {
  registryPath?: string
  watcher?: Watcher
  scan?: () => ScanResult
  poller?: Poller
  pollMs?: number
}

export interface MissionControlServer {
  server: Server
  url: string
  close(): Promise<void>
}

interface RunRoute { hash: string; runId: string; sub: 'index' | 'model' | 'events' }

// Pure: parses /run/<hash>/<runId>[/model|/events]. Plain segment splitting
// instead of a regex — easier to read and to unit test in isolation.
export function matchRunRoute(pathname: string): RunRoute | null {
  const parts = pathname.split('/').filter((p) => p.length > 0)
  if (parts[0] !== 'run' || !parts[1] || !parts[2]) return null
  if (parts.length === 3) return { hash: parts[1], runId: parts[2], sub: 'index' }
  if (parts.length === 4 && (parts[3] === 'model' || parts[3] === 'events')) {
    return { hash: parts[1], runId: parts[2], sub: parts[3] }
  }
  return null
}

const PAGE = buildMissionControlPage()

export function startMissionControlServer(opts: MissionControlServerOptions = {}): Promise<MissionControlServer> {
  const watch = opts.watcher ?? fsWatcher
  const poll = opts.poller ?? intervalPoller
  const pollMs = opts.pollMs ?? 2000
  const registryPath = opts.registryPath ?? defaultRegistryPath()
  const scan = opts.scan ?? (() => ({
    runs: discoverRuns(listWorkspaces(registryPath)),
    sessions: discoverClaudeCodeSessions(listWorkspaces(registryPath)),
  }))

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const path = url.pathname

    if (req.method === 'GET' && path === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(PAGE)
      return
    }

    if (req.method === 'GET' && path === '/api/runs') {
      const { runs, sessions } = scan()
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ runs, sessions }))
      return
    }

    if (req.method === 'GET' && path === '/events') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      })
      let last = JSON.stringify(scan())
      res.write(`data: ${last}\n\n`)
      res.on('error', () => {})
      const handle = poll(() => {
        const next = JSON.stringify(scan())
        if (snapshotChanged(last, next)) {
          last = next
          res.write(`data: ${next}\n\n`)
        }
      }, pollMs)
      req.on('close', () => handle.close())
      return
    }

    const route = req.method === 'GET' ? matchRunRoute(path) : null
    if (route) {
      const workspace = listWorkspaces(registryPath).find((w) => workspaceHash(w) === route.hash)
      if (!workspace) {
        res.writeHead(404, { 'content-type': 'text/plain' })
        res.end('unknown workspace')
        return
      }
      const journalPath = join(runsRootOf(workspace), route.runId, 'journal.jsonl')
      if (route.sub === 'model') {
        serveModel(res, { journalPath, def: bestEffortLoopDef(workspace) })
        return
      }
      if (route.sub === 'events') {
        serveEvents(req, res, { journalPath }, watch)
        return
      }
      serveIndexPage(res)
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
