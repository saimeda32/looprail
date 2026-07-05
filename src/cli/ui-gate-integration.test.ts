// End-to-end proof that a gate blocking a REAL `looprail run --ui` run can be
// answered from the dashboard's own HTTP /control endpoint, in the same
// process, and that the answer actually unblocks the still-waiting run - not
// merely that an approval gets written to gate-approvals.json (see that
// file's own docs: hasStoredApproval/storeApproval only ever help a
// NOT-YET-asked gate on a later resume/replay; they are checked BEFORE
// makeGate/makeUiGate ever prompts, so they cannot resolve an
// already-blocked rl.question()/registry promise). This file proves the
// live path instead: makeUiGate (src/cli/run-cmd.ts) registers the
// currently-waiting gate in the in-process registry
// (src/dashboard/gate-registry.ts), the dashboard server
// (src/dashboard/server.ts) resolves it via that exact same registry when a
// POST /control {action:'approve-gate'|'reject-gate'} lands, and the
// resolved GateAnswer flows through the identical normalizeGateAnswer path
// a CLI/MCP answer already does.
//
// Scope: this covers the `looprail run --ui` scenario (CLI + dashboard in
// the SAME process) only - both a plain gate and a plan-approval gate,
// both approve and reject-with-feedback. It does NOT cover a separate
// `looprail ui` viewer process resolving another process's still-running
// gate, nor a resume/replay-time live approval - see gate-approvals.ts's
// own comments for why those are architecturally different cases.
import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { runAction } from './run-cmd.js'
import { readJournal } from '../journal/journal.js'
import { runsRoot } from '../journal/runs.js'
import { createRegistry } from '../adapters/registry.js'
import { MockAdapter } from '../index.js'

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

function getJson(url: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let body = ''
      res.on('data', (c) => { body += c })
      res.on('end', () => {
        try { resolve(JSON.parse(body)) } catch (e) { reject(e) }
      })
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

// Waits until the dashboard's own /model exposes a pendingGate - i.e. until
// makeUiGate has actually registered the currently-blocked gate with the
// in-process registry AND the dashboard can see it (proving this is real
// live engine state, not something the test poked in directly).
async function waitForPendingGate(dashboardUrl: string): Promise<{ nodeId: string; isPlanApproval: boolean }> {
  let found: { nodeId: string; isPlanApproval: boolean } | undefined
  await waitFor(async () => {
    const model = await getJson(`${dashboardUrl}/model`) as { pendingGate: { nodeId: string; isPlanApproval: boolean } | null }
    if (model.pendingGate) { found = model.pendingGate; return true }
    return false
  })
  return found!
}

function captureDashboardUrl(): { io: { out: (l: string) => void }; getUrl: () => string | undefined } {
  let url: string | undefined
  return {
    io: {
      out: (l: string) => {
        const m = l.match(/http:\/\/127\.0\.0\.1:\d+/)
        if (m) url = m[0]
      },
    },
    getUrl: () => url,
  }
}

const PLAIN_GATE_FIXTURE = `
name: ui-gate-plain
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

const PLAIN_GATE_FIXTURE_ONE_ITER = `
name: ui-gate-plain-reject
goal: Needs approval.
agents:
  worker: { adapter: mock }
graph:
  do:      { role: executor, agent: worker }
  approve: { role: gate, after: do }
rails:
  max_iterations: 1
  max_cost_usd: 1
`

const PLAN_APPROVAL_FIXTURE = `
name: ui-gate-plan-approve
goal: Do the generated thing.
agents:
  planner: { adapter: mock }
graph:
  plan:    { role: planner, agent: planner, generates: graph }
  approve: { role: gate, after: plan }
rails:
  max_iterations: 5
  max_cost_usd: 1
`

const PLAN_APPROVAL_FEEDBACK_FIXTURE = `
name: ui-gate-plan-reject
goal: Do the generated thing.
agents:
  planner: { adapter: mock }
graph:
  plan:    { role: planner, agent: planner, generates: graph }
  approve: { role: gate, after: plan }
rails:
  max_iterations: 6
  max_cost_usd: 1
`

test('(1) a plain gate approved via a real HTTP POST /control unblocks a real waiting run, which proceeds to verified', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'lr-ui-gate-approve-'))
  writeFileSync(join(cwd, 'looprail.yaml'), PLAIN_GATE_FIXTURE)
  const registry = createRegistry()
  registry.register(new MockAdapter([{ output: '[mock] done' }]))
  const { io, getUrl } = captureDashboardUrl()

  const runPromise = runAction(undefined, { cwd, ui: true, port: 41701 }, { io, registry })
  await waitFor(() => !!getUrl())
  const dashboardUrl = getUrl()!
  const pending = await waitForPendingGate(dashboardUrl)
  expect(pending).toMatchObject({ nodeId: 'approve', isPlanApproval: false })

  const res = await post(`${dashboardUrl}/control`, { action: 'approve-gate' })
  expect(res.status).toBe(200)

  const code = await runPromise
  expect(code).toBe(0) // the run actually advanced past the gate to verified - not just an approval stored somewhere
})

test('(2) a plain gate rejected-with-feedback via a real HTTP POST /control reaches the engine\'s normal rejected-gate path', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'lr-ui-gate-reject-'))
  writeFileSync(join(cwd, 'looprail.yaml'), PLAIN_GATE_FIXTURE_ONE_ITER)
  const registry = createRegistry()
  registry.register(new MockAdapter([{ output: '[mock] done' }]))
  const { io, getUrl } = captureDashboardUrl()

  const runPromise = runAction(undefined, { cwd, ui: true, port: 41702 }, { io, registry })
  await waitFor(() => !!getUrl())
  const dashboardUrl = getUrl()!
  await waitForPendingGate(dashboardUrl)

  const res = await post(`${dashboardUrl}/control`, { action: 'reject-gate', text: 'not good enough yet' })
  expect(res.status).toBe(200)

  const code = await runPromise
  expect(code).toBe(2) // halted (rail breach on the next iteration attempt) - the rejection was real, not a no-op
  const runId = (readsRunId(cwd))
  const events = readJournal(join(runsRoot(cwd), runId, 'journal.jsonl'))
  const gateEnd = events.find((e) => e.type === 'node_end' && (e.data as { nodeId?: string }).nodeId === 'approve')
  // the exact free-text feedback submitted over HTTP shows up on the gate's
  // own verdict, via nodes.ts's normal GateAnswer -> verdict shaping - the
  // SAME shape a CLI/MCP rejection-with-feedback already produces
  expect((gateEnd?.data as { verdict?: { evidence?: string } })?.verdict?.evidence).toBe('human feedback: not good enough yet')
})

test('(3) a plan-approval gate approved via a real HTTP POST /control splices the fragment and the run proceeds', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'lr-ui-gate-plan-approve-'))
  writeFileSync(join(cwd, 'looprail.yaml'), PLAN_APPROVAL_FIXTURE)
  const registry = createRegistry()
  registry.register(new MockAdapter([
    { match: /PLANNER/, output: 'graph:\n  build: { role: executor, agent: planner }\n  check: { role: critic, of: build, agent: planner }\n' },
    { output: '[mock] build done' },
    { output: 'VERDICT: pass\nEVIDENCE: looks good' },
  ]))
  const { io, getUrl } = captureDashboardUrl()

  const runPromise = runAction(undefined, { cwd, ui: true, port: 41703 }, { io, registry })
  await waitFor(() => !!getUrl())
  const dashboardUrl = getUrl()!
  const pending = await waitForPendingGate(dashboardUrl)
  expect(pending).toMatchObject({ nodeId: 'approve', isPlanApproval: true })

  const res = await post(`${dashboardUrl}/control`, { action: 'approve-gate' })
  expect(res.status).toBe(200)

  const code = await runPromise
  expect(code).toBe(0)
  const runId = readsRunId(cwd)
  const events = readJournal(join(runsRoot(cwd), runId, 'journal.jsonl'))
  // the spliced "build" node actually ran as part of this same run - proof
  // the HTTP approval drove the real applySplice path, not a parallel one
  expect(events.some((e) => e.type === 'node_start' && (e.data as { nodeId?: string }).nodeId === 'build')).toBe(true)
})

test('(4) a plan-approval gate rejected-with-feedback via a real HTTP POST /control drives a real replan', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'lr-ui-gate-plan-reject-'))
  writeFileSync(join(cwd, 'looprail.yaml'), PLAN_APPROVAL_FEEDBACK_FIXTURE)
  const registry = createRegistry()
  registry.register(new MockAdapter([
    // one planner call before the first (HTTP-rejected) approval, one more
    // after the feedback-triggered replan
    { match: /PLANNER/, output: 'graph:\n  build: { role: executor, agent: planner }\n  check: { role: critic, of: build, agent: planner }\n' },
    { match: /PLANNER/, output: 'graph:\n  build: { role: executor, agent: planner }\n  check: { role: critic, of: build, agent: planner }\n' },
    { output: '[mock] build done' },
    { output: 'VERDICT: pass\nEVIDENCE: looks good' },
  ]))
  const { io, getUrl } = captureDashboardUrl()

  const runPromise = runAction(undefined, { cwd, ui: true, port: 41704 }, { io, registry })
  await waitFor(() => !!getUrl())
  const dashboardUrl = getUrl()!
  const firstPending = await waitForPendingGate(dashboardUrl)
  expect(firstPending).toMatchObject({ nodeId: 'approve', isPlanApproval: true })

  const rejectRes = await post(`${dashboardUrl}/control`, { action: 'reject-gate', text: 'add a tests node' })
  expect(rejectRes.status).toBe(200)

  // the rejection must have driven a real replan: a second plan-approval
  // gate call is what proves the planner ran again, not a flat halt
  const secondPending = await waitForPendingGate(dashboardUrl)
  expect(secondPending).toMatchObject({ nodeId: 'approve', isPlanApproval: true })

  const approveRes = await post(`${dashboardUrl}/control`, { action: 'approve-gate' })
  expect(approveRes.status).toBe(200)

  const code = await runPromise
  expect(code).toBe(0)
  const runId = readsRunId(cwd)
  const events = readJournal(join(runsRoot(cwd), runId, 'journal.jsonl'))
  const replanEvent = events.find((e) => e.type === 'replan')
  // the SAME rejection-with-feedback mechanism CLI/MCP already use: the
  // human's exact free text lands on the emitted replan event
  expect((replanEvent?.data as { feedback?: string })?.feedback).toBe('add a tests node')
})

function readsRunId(cwd: string): string {
  const runs = readdirSync(runsRoot(cwd))
  if (runs.length !== 1) throw new Error(`expected exactly one run dir, found ${runs.length}`)
  return runs[0]!
}
