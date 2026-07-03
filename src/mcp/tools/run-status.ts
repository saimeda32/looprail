import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { latestRunId, readJournal, runsRoot, summarizeJournal } from '../../index.js'
import type { McpToolDeps } from './deps.js'
import { errorResult, textResult } from './result.js'

export interface RunStatusInput {
  runId?: string
  cwd?: string
}

export async function runStatusHandler(
  input: RunStatusInput, deps: McpToolDeps,
): Promise<CallToolResult> {
  const cwd = input.cwd ?? deps.cwd
  const id = input.runId ?? latestRunId(cwd)
  if (!id) return errorResult(`no runs found under ${runsRoot(cwd)} — start one with run_loop`)
  const journalPath = join(runsRoot(cwd), id, 'journal.jsonl')
  if (!existsSync(journalPath)) return errorResult(`no journal for run "${id}"`)
  return textResult(summarizeJournal(readJournal(journalPath)))
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
