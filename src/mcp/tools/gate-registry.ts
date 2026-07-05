import type { GateAnswer, GateHandler, NodeDef, Rails } from '../../index.js'

export interface PendingGate {
  resolve: (answer: GateAnswer) => void
  question: string
  nodeId: string
  runId: string
}

// Process-lifetime registry of gate nodes currently awaiting a human answer
// via the approve_gate tool. Keyed by `${runId}:${nodeId}` so concurrent runs
// (and multiple gate nodes within one run, across iterations) never collide.
// Lives in module scope for as long as this `looprail mcp` process stays
// alive - the same scoping run_loop already relies on for its detached runs
// (see run-loop.ts): the whole point is that the process outlives any single
// tool call, so a later, separate approve_gate call can still find this run.
export const pendingGates = new Map<string, PendingGate>()

export function gateKey(runId: string, nodeId: string): string {
  return `${runId}:${nodeId}`
}

// Same injectable-timer seam as src/cli/run-cmd.ts's GateTimerDeps/makeGate:
// tests supply a fake gateTimer that rejects immediately so the timeout
// branch is exercised deterministically, with no real setTimeout involved.
export interface GateTimerDeps {
  // returns a promise that rejects with `message` after `ms` milliseconds.
  // Defaults to a real (unref'd) setTimeout; tests inject a fake that
  // rejects immediately to exercise the timeout path deterministically.
  gateTimer?: (ms: number, message: string) => Promise<never>
}

function defaultGateTimer(ms: number, message: string): Promise<never> {
  return new Promise((_, reject) => {
    const t = setTimeout(() => reject(new Error(message)), ms)
    t.unref()
  })
}

// Builds the GateHandler run_loop passes to runLoop(). Unlike the CLI's
// makeGate (which blocks synchronously on a readline question), an MCP tool
// call is request/response - there is no stdin to block on mid-call, and
// blocking run_loop itself would defeat its whole detached-run design. So
// instead of asking a question, this PAUSES the run: it registers a pending
// entry keyed by runId+node.id and returns a promise that only settles when
// a later, separate `approve_gate` tool call resolves it.
//
// The one exception mirrors the CLI exactly: if the loopfile's
// rails.gate_timeout is set, this races the pending answer against the same
// infra:-tagged timeout makeGate produces (see src/cli/run-cmd.ts), so a gate
// that times out halts the run identically whether it was started via the
// CLI or via run_loop (router.ts's infra: branch turns that rejection into a
// halt, not an ordinary rejected-gate iterate).
export function makeMcpGate(runId: string, rails: Rails, timerDeps: GateTimerDeps = {}): GateHandler {
  const gateTimer = timerDeps.gateTimer ?? defaultGateTimer
  return async (node: NodeDef, context: string) => {
    const key = gateKey(runId, node.id)
    const answered = new Promise<GateAnswer>((resolve) => {
      pendingGates.set(key, { resolve, question: context, nodeId: node.id, runId })
    })
    try {
      const timeoutSec = rails.gateTimeoutSec
      // 0 and undefined both mean "wait forever" - same convention as
      // makeGate; only a positive timeout starts the race.
      if (timeoutSec !== undefined && timeoutSec > 0) {
        return await Promise.race([
          answered,
          gateTimer(
            timeoutSec * 1000,
            `infra: gate "${node.id}" timed out after ${timeoutSec}s awaiting human approval`,
          ),
        ])
      }
      return await answered
    } finally {
      // Whether `answered` settled via approve_gate (which already deleted
      // this key itself) or the race rejected via gateTimer (timeout), make
      // sure the entry never outlives this gate call - a repeat delete of an
      // already-missing key is a harmless no-op.
      pendingGates.delete(key)
    }
  }
}

// Removes every pending-gate entry belonging to `runId`. Call once a run's
// overall promise has settled (verified, halted, or thrown) so a gate that
// never gets an answer can't sit in this Map forever.
//
// In the common case this is a no-op: the gate handler's own `finally` above
// already deletes its entry the moment its promise settles, which is what
// unblocks the run in the first place - so by the time the *overall* run
// finishes through that same gate node, nothing is left to sweep.
//
// The edge case this guards against: a run with NO gate_timeout configured,
// where a *different*, concurrent node in the same topology layer fails and
// ends the run (see scheduler.ts's Promise.all(workers) - one worker
// rejecting doesn't cancel its siblings) while this gate's node is still
// truly stuck awaiting an approve_gate call that will now never come,
// because the run is already over. Without this sweep the registry entry - 
// and the small pending-gate object it holds - would remain forever. This
// keeps the registry bounded to at most the number of *currently in-flight*
// runs' outstanding gates, never accumulating across a process's lifetime.
export function sweepPendingGates(runId: string): void {
  for (const [key, pending] of pendingGates) {
    if (pending.runId === runId) pendingGates.delete(key)
  }
}
