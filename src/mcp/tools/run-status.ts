import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import {
  latestRunId, readJournal, runsRoot, summarizeJournal, type JournalEvent,
} from '../../index.js'
import type { McpToolDeps } from './deps.js'
import { gateKey, pendingGates } from './gate-registry.js'
import { errorResult, textResult } from './result.js'

export interface RunStatusInput {
  runId?: string
  cwd?: string
}

export interface WaitingOnGate {
  nodeId: string
  question?: string
}

// A gate node is "currently pending" if the journal shows it started
// (node_start, role gate) with no matching node_end afterward — the same
// "is this node still running" signal the dashboard's view-model already
// derives (src/dashboard/view-model.ts), read fresh here since run_status
// only had run-level status (summarizeJournal) before this. Kept thin on
// purpose: a single pass over events, no new journal event types.
function findWaitingOnGate(events: JournalEvent[]): { nodeId: string } | undefined {
  const running = new Set<string>()
  for (const e of events) {
    const d = e.data as Record<string, unknown>
    if (e.type === 'node_start' && d.role === 'gate') {
      running.add(String(d.nodeId))
    } else if (e.type === 'node_end') {
      running.delete(String(d.nodeId))
    }
  }
  const [nodeId] = running
  return nodeId ? { nodeId } : undefined
}

export async function runStatusHandler(
  input: RunStatusInput, deps: McpToolDeps,
): Promise<CallToolResult> {
  const cwd = input.cwd ?? deps.cwd
  const id = input.runId ?? latestRunId(cwd)
  if (!id) return errorResult(`no runs found under ${runsRoot(cwd)} — start one with run_loop`)
  const journalPath = join(runsRoot(cwd), id, 'journal.jsonl')
  if (!existsSync(journalPath)) return errorResult(`no journal for run "${id}"`)
  const events = readJournal(journalPath)
  const summary = summarizeJournal(events)
  const waiting = findWaitingOnGate(events)
  if (!waiting) return textResult(summary)
  // Enrich with the live question text when this process is the one running
  // the gate (module-scope pendingGates — see gate-registry.ts). If it's
  // absent (e.g. a different process, or the registry entry already swept),
  // waitingOnGate still reports the nodeId — the run really is paused there
  // per the journal — just without the question text.
  const live = pendingGates.get(gateKey(id, waiting.nodeId))
  const waitingOnGate: WaitingOnGate = { nodeId: waiting.nodeId, question: live?.question }
  return textResult({ ...summary, waitingOnGate })
}

export function registerRunStatusTool(server: McpServer, deps: McpToolDeps): void {
  server.registerTool('run_status', {
    title: "Check a looprail run's status",
    description:
      'Read a run\'s current status, iteration, and cost straight from its journal ' +
      '(defaults to the latest run in cwd). Safe to call repeatedly to poll a run started by run_loop.',
    inputSchema: {
      runId: z.string().optional().describe('Run id returned by run_loop (default: the latest run in cwd)'),
      cwd: z.string().optional().describe('Working directory the run happened in (default: where looprail mcp was started)'),
    },
  }, (args) => runStatusHandler(args, deps))
}
