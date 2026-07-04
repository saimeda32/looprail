import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { lintLoop, parseLoopfile } from '../../index.js'
import type { McpToolDeps } from './deps.js'
import { errorResult, textResult } from './result.js'

export interface LintLoopfileInput {
  file: string
  cwd?: string
}

export async function lintLoopfileHandler(
  input: LintLoopfileInput, deps: McpToolDeps,
): Promise<CallToolResult> {
  const cwd = input.cwd ?? deps.cwd
  const path = resolve(cwd, input.file)
  if (!existsSync(path)) return errorResult(`cannot read ${path} - does the file exist?`)
  let def
  try {
    def = parseLoopfile(readFileSync(path, 'utf8'))
  } catch (e) {
    return errorResult(e instanceof Error ? e.message : String(e))
  }
  return textResult({ path, findings: lintLoop(def) })
}

export function registerLintLoopfileTool(server: McpServer, deps: McpToolDeps): void {
  server.registerTool('lint_loopfile', {
    title: 'Lint a loopfile',
    description:
      'Parse and statically validate a looprail.yaml (termination path, rails, ' +
      'self-judging, panel aggregation). Returns a findings list; empty means clean.',
    inputSchema: {
      file: z.string().describe('Path to the loopfile, relative to cwd'),
      cwd: z.string().optional().describe(
        'Working directory to resolve the file against (default: where looprail mcp was started)'),
    },
  }, (args) => lintLoopfileHandler(args, deps))
}
