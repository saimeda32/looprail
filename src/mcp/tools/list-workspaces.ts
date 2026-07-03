import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { defaultRegistryPath, listWorkspaces } from '../../index.js'
import type { McpToolDeps } from './deps.js'
import { textResult } from './result.js'

export async function listWorkspacesHandler(
  _input: Record<string, never>, deps: McpToolDeps,
): Promise<CallToolResult> {
  const registryPath = deps.registryPath ?? defaultRegistryPath()
  return textResult({ workspaces: listWorkspaces(registryPath) })
}

export function registerListWorkspacesTool(server: McpServer, deps: McpToolDeps): void {
  server.registerTool('list_workspaces', {
    title: 'List registered looprail workspaces',
    description:
      'List every project directory registered with looprail mission control ' +
      '(via `looprail workspace add`, or auto-registered by `looprail run`).',
    inputSchema: {},
  }, () => listWorkspacesHandler({}, deps))
}
