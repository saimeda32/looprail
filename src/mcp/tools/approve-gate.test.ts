import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { approveGateHandler } from './approve-gate.js'
import { gateKey, pendingGates } from './gate-registry.js'
import type { GateAnswer } from '../../index.js'

function tmpCwd(): string {
  return mkdtempSync(join(tmpdir(), 'lr-mcp-approve-'))
}

test('approving a gate with no pending entry returns a clear isError result, not a crash', async () => {
  const cwd = tmpCwd()
  const result = await approveGateHandler({ runId: 'run-nope', nodeId: 'approve', approved: true }, { cwd })
  expect(result.isError).toBe(true)
  const text = (result.content[0] as { text: string }).text
  expect(text).toContain('run-nope')
  expect(text).toContain('approve')
})

test('a pending gate resolves exactly once - a second approve_gate call for the same key misses cleanly', async () => {
  const cwd = tmpCwd()
  const key = gateKey('run-1', 'approve')
  const resolved: GateAnswer[] = []
  pendingGates.set(key, {
    resolve: (answer) => resolved.push(answer),
    question: 'ctx', nodeId: 'approve', runId: 'run-1',
  })

  const first = await approveGateHandler({ runId: 'run-1', nodeId: 'approve', approved: true }, { cwd })
  expect(first.isError).toBeFalsy()
  expect(resolved).toEqual([{ approved: true }])
  expect(pendingGates.has(key)).toBe(false)

  const second = await approveGateHandler({ runId: 'run-1', nodeId: 'approve', approved: false }, { cwd })
  expect(second.isError).toBe(true)
  expect(resolved).toEqual([{ approved: true }]) // unchanged - the second call never touched the (already-gone) entry
})

test('approve_gate with approved:false and a feedback string resolves the pending gate with that feedback', async () => {
  const cwd = tmpCwd()
  const key = gateKey('run-2', 'approve')
  const resolved: GateAnswer[] = []
  pendingGates.set(key, {
    resolve: (answer) => resolved.push(answer),
    question: 'ctx', nodeId: 'approve', runId: 'run-2',
  })

  const result = await approveGateHandler(
    { runId: 'run-2', nodeId: 'approve', approved: false, feedback: 'add a tests node' }, { cwd },
  )
  expect(result.isError).toBeFalsy()
  expect(resolved).toEqual([{ approved: false, feedback: 'add a tests node' }])
})

test('approve_gate with approved:true ignores any feedback string - it is only meaningful on rejection', async () => {
  const cwd = tmpCwd()
  const key = gateKey('run-3', 'approve')
  const resolved: GateAnswer[] = []
  pendingGates.set(key, {
    resolve: (answer) => resolved.push(answer),
    question: 'ctx', nodeId: 'approve', runId: 'run-3',
  })

  await approveGateHandler(
    { runId: 'run-3', nodeId: 'approve', approved: true, feedback: 'ignored' }, { cwd },
  )
  expect(resolved).toEqual([{ approved: true }])
})
