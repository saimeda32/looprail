import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { gateApprovalKey, hasStoredApproval, storeApproval } from './gate-approvals.js'
import type { NodeDef } from '../core/types.js'

const gate = (over: Partial<NodeDef> = {}): NodeDef => ({ id: 'release-check', role: 'gate', ...over })

test('gateApprovalKey differs when the gate\'s own prompt changes', () => {
  const a = gateApprovalKey(gate({ prompt: 'check A' }))
  const b = gateApprovalKey(gate({ prompt: 'check B' }))
  expect(a).not.toBe(b)
})

test('gateApprovalKey is stable for the identical gate definition', () => {
  expect(gateApprovalKey(gate({ prompt: 'check A' }))).toBe(gateApprovalKey(gate({ prompt: 'check A' })))
})

test('hasStoredApproval is false until storeApproval is called for that exact gate', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'lr-gate-'))
  const node = gate({ prompt: 'check A' })
  expect(hasStoredApproval(cwd, node)).toBe(false)
  storeApproval(cwd, node)
  expect(hasStoredApproval(cwd, node)).toBe(true)
})

test('a stored approval does not apply once the gate\'s own definition changes', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'lr-gate-'))
  storeApproval(cwd, gate({ prompt: 'check A' }))
  expect(hasStoredApproval(cwd, gate({ prompt: 'check A - revised' }))).toBe(false)
})

test('approvals are scoped to the correct workspace, not global', () => {
  const cwdA = mkdtempSync(join(tmpdir(), 'lr-gate-a-'))
  const cwdB = mkdtempSync(join(tmpdir(), 'lr-gate-b-'))
  storeApproval(cwdA, gate({ prompt: 'check A' }))
  expect(hasStoredApproval(cwdB, gate({ prompt: 'check A' }))).toBe(false)
})
