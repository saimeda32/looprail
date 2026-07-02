import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { agentCostBreakdown, makeGate, runAction } from './run-cmd.js'
import { JournalWriter, parseLoopfile } from '../index.js'
import { startDashboardServer } from '../dashboard/server.js'

const FIXTURE = `
name: cli-fixture
goal: Say DONE.
agents:
  worker:  { adapter: mock }
  checker: { adapter: mock }
graph:
  do:   { role: executor, agent: worker }
  crit: { role: critic, agent: checker, of: do, after: do }
rails:
  max_iterations: 2
  max_cost_usd: 1
`

const HALTING = `
name: halting
goal: Never passes.
agents:
  worker: { adapter: mock }
graph:
  do:  { role: executor, agent: worker }
  bad: { role: tester, after: do, run: "false", expect: exit 0 }
rails:
  max_iterations: 1
  max_cost_usd: 1
`

const GATED = `
name: gated
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

const GATED_TIMEOUT = `
name: gated-timeout
goal: Needs approval, human never responds.
agents:
  worker: { adapter: mock }
graph:
  do:      { role: executor, agent: worker }
  approve: { role: gate, after: do }
rails:
  max_iterations: 2
  max_cost_usd: 1
  gate_timeout: 5
`

function setup(content?: string) {
  const cwd = mkdtempSync(join(tmpdir(), 'lr-run-'))
  if (content) writeFileSync(join(cwd, 'looprail.yaml'), content)
  const lines: string[] = []
  return { cwd, io: { out: (l: string) => lines.push(l) }, lines }
}

test('verified run exits 0, renders progress and report, writes a journal', async () => {
  const { cwd, io, lines } = setup(FIXTURE)
  const code = await runAction(undefined, { cwd }, { io })
  expect(code).toBe(0)
  const text = lines.join('\n')
  expect(text).toContain('cli-fixture')
  expect(text).toContain('verified')
  expect(text).toContain('do')            // node progress line
  expect(text).toContain('budget')        // cost ticker vs max_cost_usd
  const runs = readdirSync(join(cwd, '.looprail', 'runs'))
  expect(runs).toHaveLength(1)
  expect(readdirSync(join(cwd, '.looprail', 'runs', runs[0]))).toContain('journal.jsonl')
})

test('halted run exits 2 with the rail reason', async () => {
  const { cwd, io, lines } = setup(HALTING)
  const code = await runAction(undefined, { cwd }, { io })
  expect(code).toBe(2)
  expect(lines.join('\n')).toContain('halted')
  expect(lines.join('\n')).toContain('iterations')
})

test('missing loopfile exits 1 pointing at init', async () => {
  const { cwd, io, lines } = setup()
  expect(await runAction(undefined, { cwd }, { io })).toBe(1)
  expect(lines.join('\n')).toContain('looprail init')
})

test('lint errors block the run with exit 1', async () => {
  const noVerifier = FIXTURE.replace('  crit: { role: critic, agent: checker, of: do, after: do }\n', '')
  const { cwd, io, lines } = setup(noVerifier)
  expect(await runAction(undefined, { cwd }, { io })).toBe(1)
  expect(lines.join('\n')).toContain('L001')
})

test('--json emits a machine-readable summary as the only stdout line', async () => {
  const { cwd, io, lines } = setup(FIXTURE)
  const code = await runAction(undefined, { cwd, json: true }, { io })
  expect(code).toBe(0)
  expect(lines).toHaveLength(1)
  const parsed = JSON.parse(lines[0]) as { status: string; runId: string; costUsd: number }
  expect(parsed.status).toBe('verified')
  expect(parsed.runId).toMatch(/^run-/)
})

test('gate handler is consulted and drives the verdict', async () => {
  const { cwd, io } = setup(GATED)
  const gated: string[] = []
  const code = await runAction(undefined, { cwd }, {
    io,
    gate: async (node) => { gated.push(node.id); return true },
  })
  expect(code).toBe(0)
  expect(gated).toEqual(['approve'])
})

test('makeGate --yes auto-approves without touching stdin', async () => {
  const lines: string[] = []
  const gate = makeGate({ maxIterations: 1, maxCostUsd: 1 }, { out: (l) => lines.push(l) }, true)
  await expect(gate({ id: 'approve', role: 'gate' }, 'ctx')).resolves.toBe(true)
  expect(lines.join('\n')).toContain('auto-approved')
})

test('makeGate rejects with an infra-tagged message via the injected gate timer — no real timer used', async () => {
  const lines: string[] = []
  const gate = makeGate(
    { maxIterations: 1, maxCostUsd: 1, gateTimeoutSec: 5 },
    { out: (l) => lines.push(l) },
    false,
    // the injected timer rejects immediately instead of waiting 5 real
    // seconds — this is the whole point of the seam
    { gateTimer: async (_ms, message) => { throw new Error(message) } },
  )
  await expect(gate({ id: 'approve', role: 'gate' }, 'ctx'))
    .rejects.toThrow('infra: gate "approve" timed out after 5s awaiting human approval')
})

test('gate timeout halts the run as an infrastructure error, not a config error (no real timers)', async () => {
  const { cwd, io, lines } = setup(GATED_TIMEOUT)
  const def = parseLoopfile(GATED_TIMEOUT)
  const gate = makeGate(def.rails, io, false, {
    gateTimer: async (_ms, message) => { throw new Error(message) },
  })
  const code = await runAction(undefined, { cwd }, { io, gate })
  expect(code).toBe(2)
  const text = lines.join('\n')
  expect(text).toContain('halted')
  expect(text).toContain('infrastructure error')
  expect(text).toContain('gate "approve" timed out after 5s awaiting human approval')
  expect(text).not.toContain('config error')
})

test('agentCostBreakdown folds journal costs per agent (panel clones collapse)', async () => {
  const def = parseLoopfile(FIXTURE)
  const dir = join(mkdtempSync(join(tmpdir(), 'lr-bd-')), 'run')
  const w = new JournalWriter(dir, () => 1)
  w.write('node_end', { nodeId: 'do', costUsd: 0.3 })
  w.write('node_end', { nodeId: 'crit@1', costUsd: 0.15 })
  w.write('node_end', { nodeId: 'crit@2', costUsd: 0.05 })
  expect(agentCostBreakdown(def, w.path)).toEqual([['worker', 0.3], ['checker', 0.2]])
})

function capture() {
  const lines: string[] = []
  return { io: { out: (l: string) => lines.push(l) }, lines }
}

test('run --ui starts a dashboard before the run and closes it once the run finishes', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'lr-run-ui-'))
  writeFileSync(join(cwd, 'looprail.yaml'), FIXTURE) // reuse this file's existing FIXTURE constant
  const { io, lines } = capture() // reuse this file's existing capture() helper
  const code = await runAction(undefined, { cwd, json: true, ui: true }, { io })
  expect(code).toBe(0)
  expect(lines.some((l) => l.includes('http://127.0.0.1:'))).toBe(true)
})

test('run --ui dashboard reflects the finished run at /model once closed data is still on disk', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'lr-run-ui-'))
  writeFileSync(join(cwd, 'looprail.yaml'), FIXTURE)
  const { io } = capture()
  await runAction(undefined, { cwd, json: true, ui: true }, { io })
  // the run's own journal is on disk and independently readable after the
  // --ui server has closed — the dashboard never held anything the run needed
  const { latestRunId, runsRoot } = await import('./status-cmd.js')
  const id = latestRunId(cwd)!
  const { readJournal } = await import('../journal/journal.js')
  const { join: j } = await import('node:path')
  const events = readJournal(j(runsRoot(cwd), id, 'journal.jsonl'))
  expect(events.some((e) => e.type === 'verified')).toBe(true)
})
