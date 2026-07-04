import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import type { McpToolDeps } from './deps.js'
import { gateKey, pendingGates } from './gate-registry.js'
import { errorResult, textResult } from './result.js'

export interface ApproveGateInput {
  runId: string
  nodeId: string
  approved: boolean
}

export async function approveGateHandler(
  input: ApproveGateInput, _deps: McpToolDeps,
): Promise<CallToolResult> {
  const key = gateKey(input.runId, input.nodeId)
  const pending = pendingGates.get(key)
  if (!pending) {
    return errorResult(
      `no pending gate found for run "${input.runId}", node "${input.nodeId}" — it may have ` +
      'already been answered, timed out, or the run hasn\'t reached it yet',
    )
  }
  // delete before resolve: the gate handler's own `finally` (gate-registry.ts)
  // would delete this same key once its promise settles anyway, but doing it
  // here too means a second approve_gate call racing this one — or the
  // gate_timeout race firing at the same instant — sees a clean miss instead
  // of a stale entry.
  pendingGates.delete(key)
  pending.resolve(input.approved)
  return textResult({
    runId: input.runId,
    nodeId: input.nodeId,
    approved: input.approved,
    status: input.approved ? 'approved' : 'rejected',
  })
}

export function registerApproveGateTool(server: McpServer, deps: McpToolDeps): void {
  server.registerTool('approve_gate', {
    title: 'Answer a pending gate in a running loop',
    description:
      'Approve or reject a gate node that a run_loop run is currently paused on. Use run_status ' +
      'to find the runId and nodeId — see its waitingOnGate field.',
    inputSchema: {
      runId: z.string().describe('Run id returned by run_loop'),
      nodeId: z.string().describe('The gate node id currently pending (see run_status.waitingOnGate.nodeId)'),
      approved: z.boolean().describe('true to approve the gate, false to reject it'),
    },
  }, async (args) => approveGateHandler(args, deps))
}
