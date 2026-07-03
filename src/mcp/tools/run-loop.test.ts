import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { readJournal } from '../../index.js'
import { runLoopHandler } from './run-loop.js'

function fixture(cwd: string, hasVerifier: boolean): void {
  writeFileSync(join(cwd, 'looprail.yaml'), `
name: demo
goal: Say DONE.
agents:
  worker: { adapter: mock }
graph:
  do: { role: executor, agent: worker }
${hasVerifier ? '  check: { role: tester, after: do, run: "true", expect: "exit 0" }' : ''}
rails:
  max_iterations: 2
  max_cost_usd: 1
`)
}

function tmpCwd(): string {
  return mkdtempSync(join(tmpdir(), 'lr-mcp-run-'))
}

test('returns a runId immediately, and the run keeps executing in the background', async () => {
  const cwd = tmpCwd()
  fixture(cwd, true)
  const { result, done } = await runLoopHandler({}, { cwd })

  // "Immediately" is a structural guarantee (runLoopHandler never awaits
  // runLoop(...) before returning `result` — see run-loop.ts), not a race
  // this test needs real time to prove. `done` below is the same promise
  // runLoop() itself returns — awaiting it is deterministic and uses no
  // timer or poll loop.
  expect(result.isError).toBeFalsy()
  const parsed = JSON.parse((result.content[0] as { text: string }).text)
  expect(parsed.runId).toMatch(/^run-/)
  expect(parsed.status).toBe('started')

  const report = await done
  expect(report?.status).toBe('verified')
  const events = readJournal(join(parsed.runDir, 'journal.jsonl'))
  expect(events.some((e) => e.type === 'verified')).toBe(true)
})

test('a loop that fails lint is rejected synchronously and never starts a background run', async () => {
  const cwd = tmpCwd()
  fixture(cwd, false) // no verifying node — L001
  const { result, done } = await runLoopHandler({}, { cwd })
  expect(result.isError).toBe(true)
  expect(await done).toBeUndefined()
  expect(existsSync(join(cwd, '.looprail', 'runs'))).toBe(false)
})

test('a loop valid pre-expansion but invalid post-expansion is rejected synchronously, never starts, and never emits a runId that looks started', async () => {
  const cwd = tmpCwd()
  // "do" panel-expands into clones "do@1"/"do@2" (see expandPanels in
  // src/core/graph.ts), which collides with the literal node id "do@1"
  // below — a duplicate-id fault validateGraph can only see on the
  // EXPANDED graph, never on the raw one lintLoop checks (raw ids
  // do/do@1/check are all unique).
  writeFileSync(join(cwd, 'looprail.yaml'), `
name: demo
goal: Say DONE.
agents:
  worker: { adapter: mock }
graph:
  do: { role: executor, agent: worker, panel: 2 }
  do@1: { role: executor, agent: worker }
  check: { role: tester, after: "do@1", run: "true", expect: "exit 0" }
rails:
  max_iterations: 2
  max_cost_usd: 1
`)
  const { result, done } = await runLoopHandler({}, { cwd })
  expect(result.isError).toBe(true)
  expect(await done).toBeUndefined()
  expect(existsSync(join(cwd, '.looprail', 'runs'))).toBe(false)
})

test('a missing loopfile returns an error result', async () => {
  const cwd = tmpCwd()
  const { result, done } = await runLoopHandler({}, { cwd })
  expect(result.isError).toBe(true)
  expect(await done).toBeUndefined()
})
