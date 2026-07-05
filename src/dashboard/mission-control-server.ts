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
import { serveControl, serveEvents, serveIndexPage, serveModel, serveResume, type ResumeOverrides } from './server.js'
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
// a timer of its own accord - everything else reacts to fs.watch or an
// incoming request. It exists only to notice OTHER processes' runs
// progressing (a `looprail run` in another terminal, writing to a journal
// this server never individually subscribed to) between one full re-scan
// and the next. Tests never touch it - see mission-control-server.test.ts,
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
  // Builds the per-run resume callback lazily, given the workspace path a
  // run's hash resolved to and its runId. Injected by the CLI layer
  // (ui-cmd.ts wraps cli/resume-cmd.ts's resumeAction) for the same reason
  // server.ts's DashboardServerOptions.onResume is: this module must not
  // import from cli/. Returns undefined for a workspace with no loadable
  // loopfile, same as bestEffortLoopDef above.
  resumeFor?: (workspace: string, runId: string) => ((overrides: ResumeOverrides) => Promise<void>) | undefined
  // Defaults to 0 (OS-assigned free port) - see server.ts's port option for
  // the full reasoning. The CLI layer requests DEFAULT_MISSION_CONTROL_PORT
  // by default - see resolveDashboardPort in ui-cmd.ts.
  port?: number
}

// See server.ts's DEFAULT_DASHBOARD_PORT - same reasoning, a different port
// so mission control and a single-run dashboard can both run at once without
// colliding on their defaults.
export const DEFAULT_MISSION_CONTROL_PORT = 4748

export interface MissionControlServer {
  server: Server
  url: string
  close(): Promise<void>
}

interface RunRoute { hash: string; runId: string; sub: 'index' | 'model' | 'events' | 'control' | 'resume' }

// Pure: parses /run/<hash>/<runId>[/model|/events|/control|/resume]. Plain
// segment splitting instead of a regex - easier to read and to unit test
// in isolation.
export function matchRunRoute(pathname: string): RunRoute | null {
  const parts = pathname.split('/').filter((p) => p.length > 0)
  if (parts[0] !== 'run' || !parts[1] || !parts[2]) return null
  if (parts.length === 3) return { hash: parts[1], runId: parts[2], sub: 'index' }
  if (parts.length === 4
    && (parts[3] === 'model' || parts[3] === 'events' || parts[3] === 'control' || parts[3] === 'resume')) {
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
      // scan() fans out into discoverRuns/discoverClaudeCodeSessions, which
      // touch the filesystem of every registered workspace. Those two are
      // hardened at the source (discover.ts skips a bad workspace instead of
      // throwing), but this catch is deliberate defense in depth: any
      // throw from scan() - including from future code - must become a
      // clean 500, never an uncaught exception that takes down the whole
      // `looprail ui --all` process.
      let result: ScanResult
      try {
        result = scan()
      } catch (err) {
        console.error('mission-control: /api/runs failed to scan workspaces', err)
        res.writeHead(500, { 'content-type': 'text/plain' })
        res.end('failed to scan workspaces')
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(result))
      return
    }

    if (req.method === 'GET' && path === '/events') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      })
      // Same defense-in-depth reasoning as /api/runs above, but an SSE
      // stream can't fall back to a clean 500 once headers are already
      // written - so a failed scan() here degrades to the last-known-good
      // snapshot (or an empty one on the very first frame) instead.
      let last: string
      try {
        last = JSON.stringify(scan())
      } catch (err) {
        console.error('mission-control: /events failed to scan workspaces on connect', err)
        last = JSON.stringify({ runs: [], sessions: [] })
      }
      res.write(`data: ${last}\n\n`)
      res.on('error', () => {})
      const handle = poll(() => {
        // The poll tick is the worst case of all: it fires every pollMs
        // with zero client interaction, so a throw here would crash the
        // process spontaneously in the background. Skip this tick and keep
        // the connection (and the interval) alive on failure.
        let next: string
        try {
          next = JSON.stringify(scan())
        } catch (err) {
          console.error('mission-control: /events poll tick failed to scan workspaces', err)
          return
        }
        if (snapshotChanged(last, next)) {
          last = next
          res.write(`data: ${next}\n\n`)
        }
      }, pollMs)
      req.on('close', () => handle.close())
      return
    }

    const route = req.method === 'GET' || req.method === 'POST' ? matchRunRoute(path) : null
    if (route) {
      const workspace = listWorkspaces(registryPath).find((w) => workspaceHash(w) === route.hash)
      if (!workspace) {
        res.writeHead(404, { 'content-type': 'text/plain' })
        res.end('unknown workspace')
        return
      }
      const journalPath = join(runsRootOf(workspace), route.runId, 'journal.jsonl')
      if (req.method === 'GET' && route.sub === 'model') {
        serveModel(res, {
          journalPath, def: bestEffortLoopDef(workspace), onResume: opts.resumeFor?.(workspace, route.runId),
        })
        return
      }
      if (req.method === 'GET' && route.sub === 'events') {
        serveEvents(req, res, { journalPath }, watch)
        return
      }
      if (req.method === 'POST' && route.sub === 'control') {
        void serveControl(req, res, { journalPath })
        return
      }
      if (req.method === 'POST' && route.sub === 'resume') {
        void serveResume(req, res, { journalPath, onResume: opts.resumeFor?.(workspace, route.runId) })
        return
      }
      if (req.method === 'GET' && route.sub === 'index') {
        // The page's own client fetches 'model'/'events' as relative URLs, so
        // they only resolve correctly when this page's own address ends in a
        // slash (see page.ts). Canonicalize it here rather than trusting every
        // caller (a run card's href, a bookmark, someone typing it by hand) to
        // already have one.
        if (!path.endsWith('/')) {
          res.writeHead(301, { location: path + '/' })
          res.end()
          return
        }
        serveIndexPage(res)
        return
      }
      res.writeHead(404, { 'content-type': 'text/plain' })
      res.end('not found')
      return
    }

    res.writeHead(404, { 'content-type': 'text/plain' })
    res.end('not found')
  })

  return new Promise((resolve, reject) => {
    server.once('error', (e: NodeJS.ErrnoException) => {
      reject(e.code === 'EADDRINUSE'
        ? new Error(`port ${opts.port} is already in use - stop whatever is using it, or drop --port to pick a free one automatically`)
        : e)
    })
    server.listen(opts.port ?? 0, '127.0.0.1', () => {
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

