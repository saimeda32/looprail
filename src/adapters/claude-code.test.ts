import { describe, expect, test } from 'vitest'
import { createClaudeCodeAdapter, parseClaudeJson } from './claude-code.js'
import type { ExecFn } from './cli-adapter.js'

const ENVELOPE = JSON.stringify({
  type: 'result', subtype: 'success', is_error: false,
  result: 'THE ANSWER', total_cost_usd: 0.0123,
  usage: { input_tokens: 1000, output_tokens: 250 },
})

describe('parseClaudeJson', () => {
  test('parses the JSON envelope into output/cost/tokens', () => {
    expect(parseClaudeJson(ENVELOPE)).toEqual({
      output: 'THE ANSWER', costUsd: 0.0123, tokens: 1250,
    })
  })

  test('falls back to raw text when stdout is not the envelope', () => {
    expect(parseClaudeJson('plain text reply\n')).toEqual({ output: 'plain text reply' })
    expect(parseClaudeJson('{"no":"result field"}')).toEqual({ output: '{"no":"result field"}' })
  })
})

describe('createClaudeCodeAdapter', () => {
  test('invokes claude -p with JSON output and per-request --model', async () => {
    const calls: { file: string; args: string[] }[] = []
    const exec: ExecFn = async (file, args) => {
      calls.push({ file, args })
      return { stdout: ENVELOPE, stderr: '', exitCode: 0 }
    }
    const adapter = createClaudeCodeAdapter({ exec })
    const res = await adapter.invoke({ prompt: 'fix it', model: 'sonnet' })
    expect(calls[0].file).toBe('claude')
    expect(calls[0].args).toEqual(['-p', 'fix it', '--output-format', 'json', '--model', 'sonnet'])
    expect(res).toMatchObject({ output: 'THE ANSWER', costUsd: 0.0123, tokens: 1250 })
  })

  test('omits --model when the request has none', async () => {
    const calls: string[][] = []
    const exec: ExecFn = async (_f, args) => {
      calls.push(args)
      return { stdout: ENVELOPE, stderr: '', exitCode: 0 }
    }
    await createClaudeCodeAdapter({ exec }).invoke({ prompt: 'p' })
    expect(calls[0]).toEqual(['-p', 'p', '--output-format', 'json'])
  })
})
