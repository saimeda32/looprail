import http, { createServer, type Server } from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { runLoop } from './runner.js'
import { readJournal } from '../journal/journal.js'
import { MockAdapter } from '../adapters/mock.js'
import { createRegistry } from '../adapters/registry.js'
import type { JournalEvent, LoopDef } from '../core/types.js'
import { getPendingPermission } from '../dashboard/permission-registry.js'
import { buildViewModel } from '../dashboard/view-model.js'
import { serveControl } from '../dashboard/server.js'

// startDashboardServer (a whole second, separately-maintained createServer
// + listen implementation) was deleted in favor of consolidating every
// real dashboard entrypoint onto mission-control-server.ts - see that
// file's own routing and dashboard/server.test.ts's identically-scoped
// local harness for the full rationale. This test only needs POST
// /control's real serveControl route (not the full multi-route/workspace
// apparatus mission-control-server.ts wires up), so it gets its own
// minimal, test-only wrapper around exactly that one function - proving
// the same production serveControl code a human's browser POST would
// hit, without needing to fabricate a registered workspace for a run
// this test drives directly through runLoop (no cwd/registry involved).
interface TestDashboard {
  server: Server
  url: string
  close(): Promise<void>
}

function startTestControlServer(journalPath: string): Promise<TestDashboard> {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (req.method === 'POST' && url.pathname === '/control') {
      void serveControl(req, res, { journalPath })
      return
    }
    res.writeHead(404, { 'content-type': 'text/plain' })
    res.end('not found')
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
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

const loop = (over: Partial<LoopDef> = {}): LoopDef => ({
  name: 'demo',
  goal: 'write a file with a real permission prompt in the way',
  agents: { a: { adapter: 'mock' } },
  nodes: [
    { id: 'do', role: 'executor', agent: 'a' },
    { id: 'crit', role: 'critic', agent: 'a', of: 'do', after: ['do'] },
  ],
  rails: { maxIterations: 2, maxCostUsd: 5, stallAfter: 2 },
  verdictPolicy: { kind: 'all-pass' },
  ...over,
})

function post(url: string, body: unknown): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body)
    const req = http.request(
      url, { method: 'POST', headers: { 'content-type': 'application/json' } },
      (res) => {
        let resBody = ''
        res.on('data', (chunk) => { resBody += chunk })
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: resBody }))
      },
    )
    req.on('error', reject)
    req.end(data)
  })
}

// End-to-end demonstration of the whole detect -> surface -> answer ->
// reaches-subprocess chain, exercised for real at every layer except the
// underlying "CLI subprocess" itself (which is the MockAdapter - see that
// file's own promptPermission field). Nothing here reimplements any of the
// links: the run goes through the real runLoop, the pending prompt is read
// back through the real permission-registry.ts and folded into a real
// dashboard view-model via view-model.ts, and it is answered through a
// REAL, started dashboard server's POST /control action - the exact same
// answer-permission code path a human clicking "Approve" in the browser
// would hit (see dashboard/server.ts's serveControl and dashboard/page.ts's
// sendPermissionDecision). If any single link breaks - the adapter stops
// calling onPermission, the registry stops registering/resolving, the
// view-model stops folding the events, or the server route stops resolving
// the real registry entry - this test fails.
test('a MockAdapter permission prompt is surfaced through the dashboard view-model and answered through the real /control answer-permission server action, reaching the subprocess', async () => {
  const mock = new MockAdapter([
    { match: /EXECUTOR/, output: 'DONE', promptPermission: { question: 'allow write to /etc/hosts?' } },
    { match: /CRITIC/, output: 'VERDICT: pass\nEVIDENCE: ok' },
  ])
  const registry = createRegistry()
  registry.register(mock)

  const runDir = join(mkdtempSync(join(tmpdir(), 'lr-e2e-')), 'run')
  const def = loop()
  const runId = 'run-permission-e2e'

  const events: JournalEvent[] = []
  const runPromise = runLoop(def, {
    registry, runId, runDir,
    onEvent: (e) => { events.push(e) },
  })

  // 1. Wait for the real permission-registry entry to appear (the same
  // process-lifetime Map runner.ts's onPermission registers into).
  let pending
  for (let i = 0; i < 400; i++) {
    pending = getPendingPermission(runId)
    if (pending) break
    await new Promise((r) => setTimeout(r, 5))
  }
  expect(pending).toBeDefined()
  expect(pending!.nodeId).toBe('do')
  expect(pending!.question).toBe('allow write to /etc/hosts?')

  // Confirm the journal already carries the permission_request event by
  // this point, and that folding those same events through view-model.ts
  // (exactly what a running dashboard renders) shows pendingPermission on
  // the 'do' node - not a reimplementation, the real buildViewModel.
  const requestEvent = events.find((e) => e.type === 'permission_request' && e.data.nodeId === 'do')
  expect(requestEvent?.data.question).toBe('allow write to /etc/hosts?')
  const viewModel = buildViewModel(events, def)
  const doNode = viewModel.nodes.find((n) => n.id === 'do')
  expect(doNode?.pendingPermission).toEqual({ question: 'allow write to /etc/hosts?' })

  // 2. Answer it through a REAL, started dashboard server's /control
  // answer-permission action - no injected fake getPendingPermission/
  // resolvePendingPermission, so this hits the exact same production
  // permission-registry.ts Map runner.ts's onPermission registered into.
  let dashboard: TestDashboard | undefined
  try {
    dashboard = await startTestControlServer(join(runDir, 'journal.jsonl'))
    const res = await post(dashboard.url + '/control', { action: 'answer-permission', nodeId: 'do', approved: true })
    expect(res.status).toBe(200)
  } finally {
    if (dashboard) await dashboard.close()
  }

  // 3. Let the run finish, then assert the answer really reached the
  // "subprocess": MockAdapter.permissionAnswers only ever records what its
  // own onPermission call actually resolved with.
  const report = await runPromise
  expect(report.status).toBe('verified')
  expect(mock.permissionAnswers).toEqual([{ approved: true, feedback: undefined }])

  const finalEvents = readJournal(join(runDir, 'journal.jsonl'))
  const resolvedEvent = finalEvents.find((e) => e.type === 'permission_resolved' && e.data.nodeId === 'do')
  expect(resolvedEvent?.data.approved).toBe(true)
  const nodeEnd = finalEvents.find((e) => e.type === 'node_end' && e.data.nodeId === 'do')
  expect(nodeEnd?.data.output).toBe('DONE')

  // Swept once the run settled - no leftover pending entry for this run.
  expect(getPendingPermission(runId)).toBeUndefined()

  // And the view-model built from the FULL final journal shows the
  // pendingPermission cleared again, same as a dashboard watching live
  // would render once the human's answer lands.
  const finalViewModel = buildViewModel(finalEvents, def)
  expect(finalViewModel.nodes.find((n) => n.id === 'do')?.pendingPermission).toBeUndefined()
})
