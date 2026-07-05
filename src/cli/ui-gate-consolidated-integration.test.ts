// Proves that a human gate blocking a REAL, still-running `looprail run --ui`
// loop can be approved through the CONSOLIDATED dashboard server - i.e.
// through mission-control-server.ts's per-run routing
// (`/run/<workspaceHash>/<runId>/...`), not through server.ts's old
// root-level `/control` / `/model`.
//
// This is deliberately a NARROWER companion to ui-gate-integration.test.ts
// (which proves the same in-process gate/resume wiring against the OLD
// root-level routes that `run --ui` used to serve). This file proves the
// identical guarantee survives the consolidation of server.ts's standalone
// dashboard into mission-control-server.ts:
//
//   - GET  /run/<hash>/<runId>/model   exposes the live pendingGate - proving
//     the run's dashboard is reading gate-registry.ts's real, module-scope
//     pendingGates Map (the same one makeUiGate registers into), because
//     `run --ui` and the dashboard server share ONE process.
//   - POST /run/<hash>/<runId>/control {action:'approve-gate'} actually
//     unblocks the still-waiting run so it proceeds to verified - not merely
//     a 200 response with no effect.
//
// AT THE TIME THIS TEST WAS WRITTEN, `run --ui` still starts server.ts's
// OLD standalone dashboard (startDashboardServer), which serves this run's
// view at the server's ROOT (`/model`, `/control`) with no `/run/<hash>/
// <runId>` prefix at all. So this test currently 404s: appending
// `/run/<hash>/<runId>/model` to the dashboard's own origin hits a path the
// old server never registered a route for. That 404 - not a typo, not a
// timeout - is exactly the failure this test is meant to capture, and is
// exactly what consolidating onto mission-control-server.ts's routing (which
// DOES mount `/run/<hash>/<runId>/...`) fixes.
import { mkdtempSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { runAction } from './run-cmd.js'
import { createRegistry } from '../adapters/registry.js'
import { MockAdapter } from '../index.js'
import { workspaceHash } from '../journal/runs.js'

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

function getRaw(url: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let body = ''
      res.on('data', (c) => { body += c })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
    }).on('error', reject)
  })
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 4000): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return
    await new Promise((r) => setTimeout(r, 15))
  }
  throw new Error('waitFor timed out')
}

// Same shape as ui-gate-integration.test.ts's own helper, but reading from
// the deep-linked per-run route instead of the dashboard's root.
async function waitForPendingGateAt(
  runModelUrl: string,
): Promise<{ nodeId: string; isPlanApproval: boolean }> {
  let found: { nodeId: string; isPlanApproval: boolean } | undefined
  await waitFor(async () => {
    const { status, body } = await getRaw(runModelUrl)
    if (status !== 200) return false
    const model = JSON.parse(body) as { pendingGate: { nodeId: string; isPlanApproval: boolean } | null }
    if (model.pendingGate) { found = model.pendingGate; return true }
    return false
  })
  return found!
}

function captureDashboardUrl(): { io: { out: (l: string) => void }; getUrl: () => string | undefined } {
  let url: string | undefined
  return {
    io: {
      // Only captures the ORIGIN (scheme://host:port), never a trailing
      // path - this matters here because a consolidated `run --ui` is
      // expected to print a deep-linked URL like
      // `http://127.0.0.1:PORT/run/<hash>/<runId>/`, and this test builds
      // its own `/run/<hash>/<runId>/...` request paths on top of the bare
      // origin rather than assuming any particular printed path shape.
      out: (l: string) => {
        const m = l.match(/http:\/\/127\.0\.0\.1:\d+/)
        if (m) url = m[0]
      },
    },
    getUrl: () => url,
  }
}

const PLAIN_GATE_FIXTURE = `
name: ui-gate-consolidated-plain
goal: Needs approval.
agents:
  worker: { adapter: mock }
graph:
  do:      { role: executor, agent: worker }
  approve: { role: gate, after: do }
rails:
  max_iterations: 2
  max_cost_usd: 1
`

test('a plain gate approved via POST /run/<hash>/<runId>/control unblocks a real waiting `run --ui` loop, which proceeds to verified', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'lr-ui-gate-consolidated-'))
  writeFileSync(join(cwd, 'looprail.yaml'), PLAIN_GATE_FIXTURE)
  const registryPath = join(mkdtempSync(join(tmpdir(), 'lr-ui-gate-consolidated-reg-')), 'workspaces.json')
  const registry = createRegistry()
  registry.register(new MockAdapter([{ output: '[mock] done' }]))
  const { io, getUrl } = captureDashboardUrl()

  const runPromise = runAction(undefined, { cwd, ui: true, port: 41801 }, { io, registry, registryPath })
  await waitFor(() => !!getUrl())
  const dashboardOrigin = getUrl()!

  // Computed independently of anything the run itself reports, exactly as
  // a real browser bookmarking a mission-control deep link would - proving
  // this is the SAME hash/runId scheme mission-control-server.ts's
  // matchRunRoute already expects, not a value smuggled out of the server.
  const hash = workspaceHash(cwd)

  // The run's own runId is not otherwise exposed synchronously, so poll the
  // one run directory that appears under this workspace's runs root once
  // the run has started - mirrors readsRunId in ui-gate-integration.test.ts.
  const { readdirSync } = await import('node:fs')
  const { runsRoot } = await import('../journal/runs.js')
  let runId: string | undefined
  await waitFor(() => {
    const dirs = readdirSync(runsRoot(cwd))
    if (dirs.length === 1) { runId = dirs[0]; return true }
    return false
  })

  const runModelUrl = `${dashboardOrigin}/run/${hash}/${runId}/model`
  const runControlUrl = `${dashboardOrigin}/run/${hash}/${runId}/control`

  // THE KEY ASSERTION (a): the deep-linked per-run route must expose the
  // live pendingGate, proving it reads gate-registry.ts's real in-process
  // Map. Against the OLD server.ts-only wiring this 404s (no /run/ route
  // exists at all), so waitForPendingGateAt would time out having only ever
  // observed 404s - fail loudly with that context instead of a bare timeout.
  const pending = await waitForPendingGateAt(runModelUrl).catch((e) => {
    throw new Error(
      `expected ${runModelUrl} to eventually expose a pendingGate; this 404s against the OLD `
      + `server.ts-only wiring (no /run/<hash>/<runId> prefix existed there) - consolidate `
      + `run --ui onto mission-control-server.ts. Original error: ${(e as Error).message}`,
    )
  })
  expect(pending).toMatchObject({ nodeId: 'approve', isPlanApproval: false })

  // THE KEY ASSERTION (b): approving through this SAME deep-linked route
  // must actually unblock the still-running loop, not just return 200.
  const res = await post(runControlUrl, { action: 'approve-gate' })
  expect(res.status).toBe(200)

  const code = await runPromise
  expect(code).toBe(0) // the run actually advanced past the gate to verified
})
