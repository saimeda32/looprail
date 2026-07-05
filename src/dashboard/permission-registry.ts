// IMPORTANT: this registry is NOT the engine's gate mechanism (see
// gate-registry.ts) and must not be confused with it, even though the two
// shapes look almost identical on purpose (see below).
//
// A `role: gate` node pauses the ENGINE between nodes: the scheduler simply
// does not start the next node until a GateHandler resolves. Nothing is
// running while a gate waits.
//
// A pending PERMISSION, by contrast, happens INSIDE a single node's own
// execution: an underlying agent CLI subprocess (see adapters/cli-adapter.ts)
// is already running, has written a tool-permission prompt to its own
// stdout, and is now blocked waiting for an answer on ITS OWN stdin - the
// node has not finished, the scheduler has not paused, and no other node's
// scheduling is affected. The "answer" here is not a GateAnswer routed back
// into loop control flow; it is raw bytes relayed into that exact
// subprocess's stdin so the CLI's OWN permission system can unblock itself.
//
// The two mechanisms are deliberately given the SAME registry shape (a
// process-lifetime Map keyed by `${runId}:${nodeId}`, holding a `resolve`
// callback plus the question that produced it) because they share the same
// underlying problem: a dashboard HTTP request is request/response, there is
// no stdin to block the SERVER on, so the answer has to be threaded through a
// promise that some other in-flight async operation (the gate's
// GateHandler call, or here, the adapter's stdin-write callback) is already
// awaiting. Reusing the shape avoids inventing a second, parallel Map
// mechanism for what is structurally the same "somebody elsewhere is
// awaiting a promise, resolve it from an HTTP handler" problem - it does NOT
// mean the two are interchangeable, and nothing here schedules or skips
// nodes.
export interface PendingPermission {
  resolve: (answer: string) => void
  question: string
  nodeId: string
  runId: string
}

// Process-lifetime registry of agent-CLI permission prompts currently
// blocking a node's subprocess mid-execution, awaiting a human answer via
// the dashboard's /control answer-permission action. Keyed by
// `${runId}:${nodeId}`. Lives in module scope for as long as this process
// (the `looprail run --ui` CLI process, which hosts both the run and its
// dashboard server) stays alive - same lifetime rationale as pendingGates.
export const pendingPermissions = new Map<string, PendingPermission>()

export function permissionKey(runId: string, nodeId: string): string {
  return `${runId}:${nodeId}`
}

// Registers a permission prompt as currently awaiting a human answer.
// Returns nothing; callers hold their own promise (constructed around this
// same `resolve`) that they await before writing the answer to the
// subprocess's stdin.
export function registerPendingPermission(entry: PendingPermission): void {
  pendingPermissions.set(permissionKey(entry.runId, entry.nodeId), entry)
}

// Resolves the pending permission prompt at runId:nodeId with `answer`
// (the raw string to relay into the subprocess's stdin), deleting the entry
// so a repeat call is a harmless no-op. Returns true iff an entry was
// actually found and resolved.
export function resolvePendingPermission(runId: string, nodeId: string, answer: string): boolean {
  const key = permissionKey(runId, nodeId)
  const pending = pendingPermissions.get(key)
  if (!pending) return false
  pendingPermissions.delete(key)
  pending.resolve(answer)
  return true
}

// Returns the currently-waiting permission prompt for `runId`, or undefined
// if no node in that run currently has one pending. A run's nodes execute
// with real (if limited) parallelism, so unlike a gate (at most one gate
// waiting per run at a time), more than one node's subprocess COULD be
// blocked on its own prompt simultaneously - this returns the first match
// found, which is sufficient for a dashboard that renders per-node pending
// state (see view-model.ts) rather than a single run-wide banner.
export function getPendingPermission(runId: string): PendingPermission | undefined {
  for (const pending of pendingPermissions.values()) {
    if (pending.runId === runId) return pending
  }
  return undefined
}

// Removes every pending-permission entry belonging to `runId`. Call once a
// run's overall promise has settled (verified, halted, or thrown) so a
// prompt that never gets an answer can't sit in this Map forever - same
// rationale as gate-registry.ts's sweepPendingGates.
export function sweepPendingPermissions(runId: string): void {
  for (const [key, pending] of pendingPermissions) {
    if (pending.runId === runId) pendingPermissions.delete(key)
  }
}
