import { join } from 'node:path'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import {
  defaultRegistryPath, discoverRuns, listRunIds, listWorkspaces, readJournal, runsRoot,
  summarizeJournal,
} from '../../index.js'
import type { McpToolDeps } from './deps.js'
import { textResult } from './result.js'

export interface ListRunsInput {
  cwd?: string
  limit?: number
  allWorkspaces?: boolean
}

export async function listRunsHandler(
  input: ListRunsInput, deps: McpToolDeps,
): Promise<CallToolResult> {
  const limit = input.limit ?? 20
  if (input.allWorkspaces) {
    const registryPath = deps.registryPath ?? defaultRegistryPath()
    const workspaces = listWorkspaces(registryPath)
    return textResult({ scope: 'all-workspaces', runs: discoverRuns(workspaces).slice(0, limit) })
  }
  const cwd = input.cwd ?? deps.cwd
  const ids = listRunIds(cwd).slice(0, limit)
  const runs = ids.map((id) => summarizeJournal(readJournal(join(runsRoot(cwd), id, 'journal.jsonl'))))
  return textResult({ scope: 'cwd', cwd, runs })
}

export function registerListRunsTool(server: McpServer, deps: McpToolDeps): void {
  server.registerTool('list_runs', {
    title: 'List looprail runs',
    description:
      "List runs under a working directory's .looprail/runs, most recent first, " +
      'with status/iteration/cost for each.',
    inputSchema: {
      cwd: z.string().optional().describe('Working directory to list runs from (default: where looprail mcp was started)'),
      limit: z.number().int().positive().optional().describe('Max runs to return (default 20)'),
      allWorkspaces: z.boolean().optional().describe(
        'If true, list runs across every registered workspace instead of just cwd ' +
        '(requires workspaces registered via `looprail workspace add` or auto-registration on `looprail run`)'),
    },
  }, (args) => listRunsHandler(args, deps))
}
