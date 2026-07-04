import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { approveGateHandler } from './approve-gate.js'
import { gateKey, pendingGates } from './gate-registry.js'

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
  const resolved: boolean[] = []
  pendingGates.set(key, {
    resolve: (approved) => resolved.push(approved),
    question: 'ctx', nodeId: 'approve', runId: 'run-1',
  })

  const first = await approveGateHandler({ runId: 'run-1', nodeId: 'approve', approved: true }, { cwd })
  expect(first.isError).toBeFalsy()
  expect(resolved).toEqual([true])
  expect(pendingGates.has(key)).toBe(false)

  const second = await approveGateHandler({ runId: 'run-1', nodeId: 'approve', approved: false }, { cwd })
  expect(second.isError).toBe(true)
  expect(resolved).toEqual([true]) // unchanged - the second call never touched the (already-gone) entry
})
