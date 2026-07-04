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
//
// Returns EVERY currently-pending gate, in journal order: the scheduler can
// run several independent gate nodes concurrently (default concurrency 4, no
// edge between them), so more than one can be paused at once. Reporting only
// the first would hide the others until it's resolved.
function findWaitingGates(events: JournalEvent[]): string[] {
  const running: string[] = []
  for (const e of events) {
    const d = e.data as Record<string, unknown>
    if (e.type === 'node_start' && d.role === 'gate') {
      const nodeId = String(d.nodeId)
      if (!running.includes(nodeId)) running.push(nodeId)
    } else if (e.type === 'node_end') {
      const nodeId = String(d.nodeId)
      const i = running.indexOf(nodeId)
      if (i !== -1) running.splice(i, 1)
    }
  }
  return running
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
  const waiting = findWaitingGates(events)
  if (waiting.length === 0) return textResult(summary)
  // Enrich each gate with its live question text when this process is the one
  // running it (module-scope pendingGates — see gate-registry.ts). If a gate's
  // entry is absent (e.g. a different process, or it was already swept),
  // waitingOnGates still reports its nodeId — the run really is paused there
  // per the journal — just without the question text.
  const waitingOnGates: WaitingOnGate[] = waiting.map((nodeId) => ({
    nodeId,
    question: pendingGates.get(gateKey(id, nodeId))?.question,
  }))
  return textResult({ ...summary, waitingOnGates })
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
