import { createRequire } from 'node:module'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { McpToolDeps } from './tools/deps.js'
import { registerLintLoopfileTool } from './tools/lint-loopfile.js'
import { registerRunLoopTool } from './tools/run-loop.js'
import { registerRunStatusTool } from './tools/run-status.js'
import { registerListRunsTool } from './tools/list-runs.js'
import { registerExplainNodeTool } from './tools/explain-node.js'
import { registerListWorkspacesTool } from './tools/list-workspaces.js'
import { registerApproveGateTool } from './tools/approve-gate.js'

const pkg = createRequire(import.meta.url)('../../package.json') as { version: string }

export interface McpServerDeps extends McpToolDeps {}

export function createLooprailMcpServer(deps: McpServerDeps): McpServer {
  const server = new McpServer({ name: 'looprail', version: pkg.version })
  registerLintLoopfileTool(server, deps)
  registerRunLoopTool(server, deps)
  registerRunStatusTool(server, deps)
  registerListRunsTool(server, deps)
  registerExplainNodeTool(server, deps)
  registerListWorkspacesTool(server, deps)
  registerApproveGateTool(server, deps)
  return server
}
