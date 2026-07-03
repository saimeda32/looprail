import { createRequire } from 'node:module'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { McpToolDeps } from './tools/deps.js'
import { registerLintLoopfileTool } from './tools/lint-loopfile.js'

const pkg = createRequire(import.meta.url)('../../package.json') as { version: string }

export interface McpServerDeps extends McpToolDeps {}

export function createLooprailMcpServer(deps: McpServerDeps): McpServer {
  const server = new McpServer({ name: 'looprail', version: pkg.version })
  registerLintLoopfileTool(server, deps)
  // Tasks 2-6 each add one more registerXTool(server, deps) call here.
  return server
}
