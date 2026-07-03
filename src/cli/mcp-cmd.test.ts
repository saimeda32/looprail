import { expect, test } from 'vitest'
import { buildProgram } from './index.js'

test('the mcp subcommand is registered and described for the target hosts', () => {
  const help = buildProgram().helpInformation()
  expect(help).toContain('mcp')
  expect(help).toContain('Claude Desktop')
})
