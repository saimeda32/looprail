import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { composeContext, parseLoopfile, type NodeOutcome, type RunState } from '../../index.js'
import type { McpToolDeps } from './deps.js'
import { errorResult, textResult } from './result.js'

export interface ExplainNodeInput {
  file: string
  node: string
  cwd?: string
}

// Builds the same placeholder-filled dry-run context src/cli/explain-cmd.ts
// builds. Duplicated here in miniature rather than imported, so src/mcp/
// only ever depends on the public SDK surface (src/index.ts), never on
// src/cli/ - see this plan's Global Constraints and design decision 3.
export async function explainNodeHandler(
  input: ExplainNodeInput, toolDeps: McpToolDeps,
): Promise<CallToolResult> {
  const cwd = input.cwd ?? toolDeps.cwd
  const path = resolve(cwd, input.file)
  if (!existsSync(path)) return errorResult(`no loopfile at ${path}`)

  let def
  try {
    def = parseLoopfile(readFileSync(path, 'utf8'))
  } catch (e) {
    return errorResult(e instanceof Error ? e.message : String(e))
  }

  const node = def.nodes.find((n) => n.id === input.node)
  if (!node) {
    return errorResult(`no node "${input.node}" - nodes: ${def.nodes.map((n) => n.id).join(', ')}`)
  }

  const outcomes = new Map<string, NodeOutcome>()
  const depIds = [...(node.after ?? []), ...(node.of ? [node.of] : [])]
  for (const dep of depIds) {
    outcomes.set(dep, {
      nodeId: dep,
      role: def.nodes.find((n) => n.id === dep)?.role ?? 'executor',
      output: `<output of "${dep}" - placeholder>`,
      verdict: null, costUsd: 0, tokens: 0, durationMs: 0,
    })
  }
  const state: RunState = { plan: '<current plan - placeholder>', iteration: 1, feedback: null }
  return textResult(composeContext(def, node, state, outcomes))
}

export function registerExplainNodeTool(server: McpServer, deps: McpToolDeps): void {
  server.registerTool('explain_node', {
    title: "Explain a node's context",
    description:
      'Dry-run exactly what context a node in a loopfile would receive, without running ' +
      'anything (upstream outputs are shown as placeholders).',
    inputSchema: {
      file: z.string().describe('Path to the loopfile, relative to cwd'),
      node: z.string().describe("Node id from the loopfile's graph"),
      cwd: z.string().optional().describe('Working directory to resolve the file against'),
    },
  }, (args) => explainNodeHandler(args, deps))
}
