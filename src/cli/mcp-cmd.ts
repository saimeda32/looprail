import type { Command } from 'commander'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { createLooprailMcpServer } from '../mcp/server.js'

// looprail mcp is deliberately silent on stdout: StdioServerTransport owns
// stdin/stdout completely as the MCP JSON-RPC channel for as long as this
// process runs. A stray console.log/banner would corrupt every message the
// connected host (Claude Desktop / Cursor / VS Code) reads from this
// process - so unlike every other *-cmd.ts file in this codebase, this one
// never imports CliIo/defaultIo. Any diagnostic this plan's code needs to
// report goes to stderr via console.error (see run-loop.ts).
export async function mcpAction(opts: { cwd: string }): Promise<void> {
  const server = createLooprailMcpServer({ cwd: opts.cwd })
  const transport = new StdioServerTransport()
  await server.connect(transport)
}

export function registerMcp(program: Command): void {
  program
    .command('mcp')
    .description(
      'start looprail as an MCP server over stdio, for Claude Desktop, Cursor, or VS Code Copilot Chat')
    .action(async (_opts: unknown, cmd: Command) => {
      const { cwd } = cmd.optsWithGlobals<{ cwd: string }>()
      await mcpAction({ cwd })
    })
}
