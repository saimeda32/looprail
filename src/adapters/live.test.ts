import { describe, expect, test } from 'vitest'
import { createClaudeCodeAdapter } from './claude-code.js'
import { createCodexAdapter } from './codex.js'
import { createCopilotAdapter } from './copilot.js'

const live = process.env.LOOPRAIL_LIVE === '1'

describe.skipIf(!live)('live adapter smoke (LOOPRAIL_LIVE=1, maintainers only)', () => {
  test('claude-code answers a trivial prompt', async () => {
    const res = await createClaudeCodeAdapter().invoke({ prompt: 'Reply with exactly: PONG' })
    expect(res.output).toContain('PONG')
  }, 180_000)

  test('claude-code streams real chunks for a trivial prompt', async () => {
    const chunks: string[] = []
    await createClaudeCodeAdapter().invoke({ prompt: 'Reply with exactly: PONG' }, (c) => chunks.push(c))
    expect(chunks.length).toBeGreaterThan(0)
    expect(chunks.join('')).toContain('PONG')
  }, 180_000)

  test('codex answers a trivial prompt', async () => {
    const res = await createCodexAdapter().invoke({ prompt: 'Reply with exactly: PONG' })
    expect(res.output).toContain('PONG')
  }, 180_000)

  test('copilot-cli answers a trivial prompt and streams real token deltas', async () => {
    const chunks: string[] = []
    const res = await createCopilotAdapter().invoke({ prompt: 'Reply with exactly: PONG' }, (c) => chunks.push(c))
    expect(res.output).toContain('PONG')
    expect(chunks.length).toBeGreaterThan(0)
  }, 180_000)
})
