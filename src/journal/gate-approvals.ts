import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { NodeDef } from '../core/types.js'
import { runsRoot } from './runs.js'

// Keyed by a hash of the gate's own definition (not just its id) so editing
// what a gate actually checks invalidates any previously-stored approval for
// it automatically - a stale "yes" from before the gate changed must never
// silently carry over to a genuinely different question.
export function gateApprovalKey(node: NodeDef): string {
  const material = JSON.stringify({
    id: node.id, prompt: node.prompt, after: node.after, of: node.of,
  })
  return createHash('sha256').update(material).digest('hex').slice(0, 16)
}

function approvalsPath(cwd: string): string {
  return join(runsRoot(cwd), 'gate-approvals.json')
}

function readApprovals(cwd: string): Set<string> {
  const path = approvalsPath(cwd)
  if (!existsSync(path)) return new Set()
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as string[]
    return new Set(raw)
  } catch {
    return new Set()
  }
}

export function hasStoredApproval(cwd: string, node: NodeDef): boolean {
  return readApprovals(cwd).has(gateApprovalKey(node))
}

export function storeApproval(cwd: string, node: NodeDef): void {
  const path = approvalsPath(cwd)
  mkdirSync(runsRoot(cwd), { recursive: true })
  const approvals = readApprovals(cwd)
  approvals.add(gateApprovalKey(node))
  writeFileSync(path, JSON.stringify([...approvals]))
}
