import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { parseQueueFile, queueAction } from './queue-cmd.js'
import { readJournal } from '../index.js'
import { runsRoot } from '../journal/runs.js'

const LOOPFILE = `
name: queue-fixture
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

const GATED_LOOPFILE = `
name: queue-gated
goal: Needs approval.
agents:
  worker: { adapter: mock }
graph:
  do:      { role: executor, agent: worker }
  approve: { role: gate, after: do }
rails:
  max_iterations: 2
  max_cost_usd: 1
  gate_timeout: 1
`

function setup(queueYaml: string, loopfiles: Record<string, string> = { 'looprail.yaml': LOOPFILE }) {
  const cwd = mkdtempSync(join(tmpdir(), 'lr-queue-'))
  writeFileSync(join(cwd, 'queue.yaml'), queueYaml)
  for (const [name, content] of Object.entries(loopfiles)) {
    writeFileSync(join(cwd, name), content)
  }
  const lines: string[] = []
  return { cwd, io: { out: (l: string) => lines.push(l) }, lines }
}

// --- parseQueueFile ---

test('parseQueueFile accepts goal-only, file-only, and combined items', () => {
  const items = parseQueueFile(`
queue:
  - goal: Fix the flaky tests
  - file: refactor.yaml
  - file: refactor.yaml
    goal: Refactor payments
`)
  expect(items).toEqual([
    { goal: 'Fix the flaky tests' },
    { file: 'refactor.yaml' },
    { file: 'refactor.yaml', goal: 'Refactor payments' },
  ])
})

test('parseQueueFile rejects an empty or missing queue list, and items with neither file nor goal', () => {
  expect(() => parseQueueFile('queue: []')).toThrow(/non-empty list/)
  expect(() => parseQueueFile('other: thing')).toThrow(/non-empty list/)
  expect(() => parseQueueFile('queue:\n  - {}')).toThrow(/item 1 needs a file: or a goal:/)
})

// --- queueAction ---

test('a queue of two passing goals runs both sequentially, renders the triage table, and exits 0', async () => {
  const { cwd, io, lines } = setup(`
queue:
  - goal: First goal
  - goal: Second goal
`)
  const code = await queueAction(undefined, { cwd }, { io, notifier: () => {} })
  expect(code).toBe(0)
  const text = lines.join('\n')
  expect(text).toContain('[1/2] First goal')
  expect(text).toContain('[2/2] Second goal')
  expect(text).toContain('queue triage')
  expect(text).toContain('2 verified · 0 parked · 0 halted/error')
})

test('a goal override actually reaches the run - the journal records the item goal, not the loopfile goal', async () => {
  const { cwd, io } = setup(`
queue:
  - goal: The overridden goal
`)
  const code = await queueAction(undefined, { cwd }, { io, notifier: () => {} })
  expect(code).toBe(0)
  const { readdirSync } = await import('node:fs')
  const runs = readdirSync(runsRoot(cwd))
  expect(runs).toHaveLength(1)
  const events = readJournal(join(runsRoot(cwd), runs[0], 'journal.jsonl'))
  const start = events.find((e) => e.type === 'run_start')
  expect((start?.data as { goal?: string }).goal).toBe('The overridden goal')
})

// The queue's whole reason to exist: a gated item PARKS (real 1s
// gate_timeout from its own loopfile) and the queue moves on to the next
// item instead of hanging overnight on a gate nobody is watching.
test('a gated item parks and never blocks the rest of the queue; exit code reports not-all-verified', async () => {
  const { cwd, io, lines } = setup(`
queue:
  - file: gated.yaml
  - goal: After the parked one
`, { 'looprail.yaml': LOOPFILE, 'gated.yaml': GATED_LOOPFILE })
  const notified: string[] = []
  const code = await queueAction(undefined, { cwd }, {
    io, notifier: (title, message) => { notified.push(`${title}|${message}`) },
  })
  expect(code).toBe(2)
  const text = lines.join('\n')
  expect(text).toContain('parked - awaiting your approval')
  expect(text).toContain('[2/2] After the parked one')
  expect(text).toContain('1 verified · 1 parked · 0 halted/error')
  expect(text).toContain('resume parked: looprail resume run-')
  expect(notified.some((n) => n.includes('queue finished') && n.includes('1 parked'))).toBe(true)
}, 15000)

test('--json emits one machine-readable triage summary', async () => {
  const { cwd, io, lines } = setup(`
queue:
  - goal: Only goal
`)
  const code = await queueAction(undefined, { cwd, json: true }, { io, notifier: () => {} })
  expect(code).toBe(0)
  const parsed = JSON.parse(lines.at(-1)!) as { total: number; verified: number; results: { status: string }[] }
  expect(parsed.total).toBe(1)
  expect(parsed.verified).toBe(1)
  expect(parsed.results[0].status).toBe('verified')
})

test('a missing queue file exits 1 with a clear error', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'lr-queue-'))
  const lines: string[] = []
  const code = await queueAction(undefined, { cwd }, { io: { out: (l) => lines.push(l) }, notifier: () => {} })
  expect(code).toBe(1)
})
