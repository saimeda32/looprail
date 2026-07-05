import { describe, expect, test } from 'vitest'
import {
  claudeStreamLine, createClaudeCodeAdapter, parseClaudeJson, parseClaudeStreamJsonl,
} from './claude-code.js'
import type { ExecFn } from './cli-adapter.js'

const RESULT_LINE = JSON.stringify({
  type: 'result', subtype: 'success', is_error: false,
  result: 'THE ANSWER', total_cost_usd: 0.0123,
  usage: { input_tokens: 1000, output_tokens: 250 },
})

const STREAM = [
  JSON.stringify({ type: 'system', subtype: 'init' }),
  JSON.stringify({ type: 'assistant', message: { content: [{ type: 'thinking', thinking: '' }] } }),
  JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'THE ANSWER' }] } }),
  RESULT_LINE,
].join('\n') + '\n'

describe('parseClaudeJson', () => {
  test('parses the JSON envelope into output/cost/tokens', () => {
    expect(parseClaudeJson(RESULT_LINE)).toEqual({
      output: 'THE ANSWER', costUsd: 0.0123, tokens: 1250,
    })
  })

  test('falls back to raw text when stdout is not the envelope', () => {
    expect(parseClaudeJson('plain text reply\n')).toEqual({ output: 'plain text reply' })
    expect(parseClaudeJson('{"no":"result field"}')).toEqual({ output: '{"no":"result field"}' })
  })
})

describe('parseClaudeStreamJsonl', () => {
  test('scans every line and extracts the terminal result line', () => {
    expect(parseClaudeStreamJsonl(STREAM)).toEqual({
      output: 'THE ANSWER', costUsd: 0.0123, tokens: 1250,
    })
  })

  test('falls back to raw text when no result line is present', () => {
    const noResult = [JSON.stringify({ type: 'system', subtype: 'init' })].join('\n') + '\n'
    expect(parseClaudeStreamJsonl(noResult)).toEqual({ output: noResult.trim() })
  })

  test('ignores unparseable lines instead of throwing', () => {
    const withGarbage = 'not json\n' + RESULT_LINE + '\n'
    expect(parseClaudeStreamJsonl(withGarbage)).toEqual({
      output: 'THE ANSWER', costUsd: 0.0123, tokens: 1250,
    })
  })
})

describe('claudeStreamLine', () => {
  test('surfaces a text content block verbatim', () => {
    const line = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'hello there' }] } })
    expect(claudeStreamLine(line)).toBe('hello there')
  })

  test('surfaces a thinking block as a short indicator, not raw internal reasoning', () => {
    const line = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'internal reasoning text' }] } })
    expect(claudeStreamLine(line)).toBe('[thinking...]')
  })

  test('surfaces a tool_use block as a readable summary', () => {
    const line = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Write' }] } })
    expect(claudeStreamLine(line)).toBe('[using tool: Write]')
  })

  test('ignores non-assistant lines (system, result, rate_limit_event)', () => {
    expect(claudeStreamLine(JSON.stringify({ type: 'system', subtype: 'init' }))).toBeNull()
    expect(claudeStreamLine(RESULT_LINE)).toBeNull()
  })

  test('returns null for unparseable lines instead of throwing', () => {
    expect(claudeStreamLine('not json')).toBeNull()
  })
})

describe('createClaudeCodeAdapter', () => {
  test('invokes claude -p with stream-json output and per-request --model', async () => {
    const calls: { file: string; args: string[] }[] = []
    const exec: ExecFn = async (file, args) => {
      calls.push({ file, args })
      return { stdout: STREAM, stderr: '', exitCode: 0 }
    }
    const adapter = createClaudeCodeAdapter({ exec })
    const res = await adapter.invoke({ prompt: 'fix it', model: 'sonnet' })
    expect(calls[0].file).toBe('claude')
    expect(calls[0].args).toEqual([
      '-p', 'fix it', '--output-format', 'stream-json', '--verbose', '--model', 'sonnet',
      '--permission-mode', 'acceptEdits',
    ])
    expect(res).toMatchObject({ output: 'THE ANSWER', costUsd: 0.0123, tokens: 1250 })
  })

  test('never fabricates an estimatedCostUsd alongside the real reported cost - claude-code has no estimator wired', async () => {
    const exec: ExecFn = async () => ({ stdout: STREAM, stderr: '', exitCode: 0 })
    const res = await createClaudeCodeAdapter({ exec }).invoke({ prompt: 'p', model: 'sonnet' })
    expect(res.costUsd).toBe(0.0123)
    expect(res.estimatedCostUsd).toBeUndefined()
  })

  test('omits --model when the request has none, but still applies the safe default permission flags', async () => {
    const calls: string[][] = []
    const exec: ExecFn = async (_f, args) => {
      calls.push(args)
      return { stdout: STREAM, stderr: '', exitCode: 0 }
    }
    await createClaudeCodeAdapter({ exec }).invoke({ prompt: 'p' })
    expect(calls[0]).toEqual([
      '-p', 'p', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'acceptEdits',
    ])
  })

  test('appends permission flags after --model, resolved via resolvePermissionArgs', async () => {
    const calls: string[][] = []
    const exec: ExecFn = async (_f, args) => {
      calls.push(args)
      return { stdout: STREAM, stderr: '', exitCode: 0 }
    }
    await createClaudeCodeAdapter({ exec }).invoke({ prompt: 'p', model: 'sonnet', permissions: 'full' })
    expect(calls[0]).toEqual([
      '-p', 'p', '--output-format', 'stream-json', '--verbose', '--model', 'sonnet', '--dangerously-skip-permissions',
    ])
  })

  test('omits permission flags entirely when the request has neither model nor permissions, but still applies the safe default via resolvePermissionArgs when permissions is explicitly undefined and a real request is made', async () => {
    const calls: string[][] = []
    const exec: ExecFn = async (_f, args) => {
      calls.push(args)
      return { stdout: STREAM, stderr: '', exitCode: 0 }
    }
    await createClaudeCodeAdapter({ exec }).invoke({ prompt: 'p' })
    expect(calls[0]).toEqual(['-p', 'p', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'acceptEdits'])
  })

  test('streams the thinking indicator then the real answer text live, before the node finishes', async () => {
    const chunks: string[] = []
    const exec: ExecFn = async (_file, _args, opts = {}) => {
      opts.onChunk?.(STREAM)
      return { stdout: STREAM, stderr: '', exitCode: 0 }
    }
    const adapter = createClaudeCodeAdapter({ exec })
    const res = await adapter.invoke({ prompt: 'p' }, (c) => chunks.push(c))
    expect(chunks).toEqual(['[thinking...]', 'THE ANSWER'])
    expect(res.output).toBe('THE ANSWER')
  })
})
