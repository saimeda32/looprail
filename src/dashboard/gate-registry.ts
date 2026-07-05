import type { GateAnswer } from '../index.js'

export interface PendingGate {
  resolve: (answer: GateAnswer) => void
  question: string
  nodeId: string
  runId: string
  isPlanApproval: boolean
}

// Process-lifetime registry of gate nodes currently awaiting a human answer
// via the dashboard's /control approve-gate/reject-gate actions. Keyed by
// `${runId}:${nodeId}`, mirroring src/mcp/tools/gate-registry.ts exactly - the
// same "async op, not a blocking readline call" problem shows up here: a
// dashboard HTTP request is request/response, there is no stdin to block on,
// and the run's real GateHandler (see src/cli/run-cmd.ts's makeUiGate) races
// this registry's promise against stdin and the gate timeout so whichever
// settles first wins. Lives in module scope for as long as this process
// (the `looprail run --ui` CLI process, which hosts both the run and its
// dashboard server) stays alive.
export const pendingGates = new Map<string, PendingGate>()

export function gateKey(runId: string, nodeId: string): string {
  return `${runId}:${nodeId}`
}

// Registers a gate as currently awaiting a human answer. Returns nothing;
// callers hold their own promise (constructed around this same `resolve`)
// that they await - see makeUiGate.
export function registerPendingGate(entry: PendingGate): void {
  pendingGates.set(gateKey(entry.runId, entry.nodeId), entry)
}

// Resolves the pending gate at runId:nodeId with `answer`, deleting the
// entry so a repeat call (or a stdin/timeout race loser cleaning up) is a
// harmless no-op. Returns true iff an entry was actually found and resolved.
export function resolvePendingGate(runId: string, nodeId: string, answer: GateAnswer): boolean {
  const key = gateKey(runId, nodeId)
  const pending = pendingGates.get(key)
  if (!pending) return false
  pendingGates.delete(key)
  pending.resolve(answer)
  return true
}

// Returns the currently-waiting gate for `runId`, or undefined if no gate in
// that run is currently pending. A run has at most one gate waiting at a
// time (the engine blocks the node's worker on its GateHandler call), so the
// first match is unambiguous.
export function getPendingGate(runId: string): PendingGate | undefined {
  for (const pending of pendingGates.values()) {
    if (pending.runId === runId) return pending
  }
  return undefined
}

// Removes every pending-gate entry belonging to `runId`. Call once a run's
// overall promise has settled (verified, halted, or thrown) so a gate that
// never gets an answer can't sit in this Map forever - same rationale as
// src/mcp/tools/gate-registry.ts's sweepPendingGates.
export function sweepPendingGates(runId: string): void {
  for (const [key, pending] of pendingGates) {
    if (pending.runId === runId) pendingGates.delete(key)
  }
}
