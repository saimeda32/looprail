import { describe, expect, test } from 'vitest'
import { createClaudeCodeAdapter } from './claude-code.js'
import { createCodexAdapter } from './codex.js'

const live = process.env.LOOPRAIL_LIVE === '1'

describe.skipIf(!live)('live adapter smoke (LOOPRAIL_LIVE=1, maintainers only)', () => {
  test('claude-code answers a trivial prompt', async () => {
    const res = await createClaudeCodeAdapter().invoke({ prompt: 'Reply with exactly: PONG' })
    expect(res.output).toContain('PONG')
  }, 180_000)

  test('codex answers a trivial prompt', async () => {
    const res = await createCodexAdapter().invoke({ prompt: 'Reply with exactly: PONG' })
    expect(res.output).toContain('PONG')
  }, 180_000)
})
