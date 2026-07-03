import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'

export function textResult(value: unknown): CallToolResult {
  return {
    content: [{
      type: 'text',
      text: typeof value === 'string' ? value : JSON.stringify(value, null, 2),
    }],
  }
}

export function errorResult(message: string): CallToolResult {
  return { isError: true, content: [{ type: 'text', text: message }] }
}
