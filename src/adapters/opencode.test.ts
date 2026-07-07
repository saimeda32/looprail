import { describe, expect, test } from 'vitest'
import { createOpencodeAdapter, opencodeStreamLine, parseOpencodeJsonl } from './opencode.js'
import type { ExecFn } from './cli-adapter.js'

// Fixture mirrors the exact event shapes opencode v1.17.14's own published
// source emits for `run --format json` (emit() in packages/opencode/src/cli/
// cmd/run.ts wraps each event as { type, timestamp, sessionID, ...data };
// part shapes come from the SDK's generated types). Not captured from a live
// run - no opencode provider credentials existed on the development machine
// (the CLI's flag surface WAS verified live via `opencode run --help`; see
// opencode.ts).
const JSONL = [
  JSON.stringify({ type: 'step_start', timestamp: 1, sessionID: 's1', part: { id: 'p0', type: 'step-start' } }),
  JSON.stringify({
    type: 'tool_use', timestamp: 2, sessionID: 's1',
    part: { id: 'p1', type: 'tool', tool: 'edit', state: { status: 'completed' } },
  }),
  JSON.stringify({
    type: 'text', timestamp: 3, sessionID: 's1',
    part: { id: 'p2', type: 'text', text: 'Fixed the bug.', time: { start: 1, end: 3 } },
  }),
  JSON.stringify({
    type: 'step_finish', timestamp: 4, sessionID: 's1',
    part: {
      id: 'p3', type: 'step-finish', reason: 'stop', cost: 0.0123,
      tokens: { input: 100, output: 40, reasoning: 10, cache: { read: 20, write: 5 } },
    },
  }),
].join('\n')

describe('parseOpencodeJsonl', () => {
  test('takes completed text parts, sums step_finish cost and tokens with cache folded into the input side', () => {
    expect(parseOpencodeJsonl(JSONL)).toEqual({
      output: 'Fixed the bug.',
      costUsd: 0.0123,
      tokens: 175,
      inputTokens: 125,   // 100 input + 20 cache read + 5 cache write
      outputTokens: 50,   // 40 output + 10 reasoning
    })
  })

  test('joins multiple completed text parts in arrival order, mirroring the CLI\'s own non-TTY output', () => {
    const jsonl = [
      JSON.stringify({ type: 'text', part: { id: 'a', type: 'text', text: 'First part.' } }),
      JSON.stringify({ type: 'text', part: { id: 'b', type: 'text', text: 'Second part.' } }),
    ].join('\n')
    expect(parseOpencodeJsonl(jsonl).output).toBe('First part.\nSecond part.')
  })

  test('a re-emitted snapshot of the same part id replaces rather than duplicates', () => {
    const jsonl = [
      JSON.stringify({ type: 'text', part: { id: 'a', type: 'text', text: 'draft' } }),
      JSON.stringify({ type: 'text', part: { id: 'a', type: 'text', text: 'final' } }),
    ].join('\n')
    expect(parseOpencodeJsonl(jsonl).output).toBe('final')
  })

  test('sums cost and tokens across multiple step_finish events (one per step of a multi-step turn)', () => {
    const jsonl = [
      JSON.stringify({ type: 'text', part: { id: 'a', type: 'text', text: 'ok' } }),
      JSON.stringify({ type: 'step_finish', part: { cost: 0.01, tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } } } }),
      JSON.stringify({ type: 'step_finish', part: { cost: 0.02, tokens: { input: 30, output: 15, reasoning: 0, cache: { read: 0, write: 0 } } } }),
    ].join('\n')
    expect(parseOpencodeJsonl(jsonl)).toMatchObject({ costUsd: 0.03, inputTokens: 40, outputTokens: 20, tokens: 60 })
  })

  test('falls back to raw text when no text event exists', () => {
    expect(parseOpencodeJsonl('not json at all\n')).toEqual({ output: 'not json at all' })
  })

  test('ignores unparseable lines instead of throwing', () => {
    expect(parseOpencodeJsonl('garbage\n' + JSONL).output).toBe('Fixed the bug.')
  })

  test('leaves cost/tokens undefined (never 0) when no step_finish event was emitted', () => {
    const jsonl = JSON.stringify({ type: 'text', part: { id: 'a', type: 'text', text: 'ok' } })
    const parsed = parseOpencodeJsonl(jsonl)
    expect(parsed.output).toBe('ok')
    expect(parsed.costUsd).toBeUndefined()
    expect(parsed.tokens).toBeUndefined()
    expect(parsed.inputTokens).toBeUndefined()
    expect(parsed.outputTokens).toBeUndefined()
  })
})

describe('opencodeStreamLine', () => {
  test('surfaces a completed text part snapshot', () => {
    const line = JSON.stringify({ type: 'text', part: { id: 'a', type: 'text', text: 'Fixed it.' } })
    expect(opencodeStreamLine(line)).toBe('Fixed it.')
  })

  test('announces tool use by name and ignores bookkeeping events', () => {
    expect(opencodeStreamLine(JSON.stringify({ type: 'tool_use', part: { tool: 'bash' } }))).toBe('[using tool: bash]')
    expect(opencodeStreamLine(JSON.stringify({ type: 'step_start', part: {} }))).toBeNull()
    expect(opencodeStreamLine(JSON.stringify({ type: 'step_finish', part: { cost: 0.1 } }))).toBeNull()
  })

  test('returns null for unparseable lines instead of throwing', () => {
    expect(opencodeStreamLine('not json')).toBeNull()
  })
})

describe('createOpencodeAdapter', () => {
  test('invokes opencode run with JSON event output and no permission flags by default (safe preset)', async () => {
    const calls: { file: string; args: string[] }[] = []
    const exec: ExecFn = async (file, args) => {
      calls.push({ file, args })
      return { stdout: JSONL, stderr: '', exitCode: 0 }
    }
    const res = await createOpencodeAdapter({ exec }).invoke({ prompt: 'fix the bug' })
    expect(calls[0].file).toBe('opencode')
    expect(calls[0].args).toEqual(['run', 'fix the bug', '--format', 'json'])
    expect(res).toMatchObject({ output: 'Fixed the bug.', costUsd: 0.0123, tokens: 175 })
  })

  test('appends --model (provider/model form) and --auto for the full preset', async () => {
    const calls: string[][] = []
    const exec: ExecFn = async (_file, args) => {
      calls.push(args)
      return { stdout: JSONL, stderr: '', exitCode: 0 }
    }
    await createOpencodeAdapter({ exec }).invoke({
      prompt: 'fix it', model: 'anthropic/claude-sonnet-4-5', permissions: 'full',
    })
    expect(calls[0]).toEqual([
      'run', 'fix it', '--format', 'json', '--model', 'anthropic/claude-sonnet-4-5', '--auto',
    ])
  })

  test('reports opencode\'s own cost as costUsd (adapter-reported, like claude-code) with no competing estimate', async () => {
    const exec: ExecFn = async () => ({ stdout: JSONL, stderr: '', exitCode: 0 })
    const res = await createOpencodeAdapter({ exec }).invoke({ prompt: 'p' })
    expect(res.costUsd).toBeCloseTo(0.0123)
    expect(res.estimatedCostUsd).toBeUndefined()
    expect(res.inputTokens).toBe(125)
    expect(res.outputTokens).toBe(50)
  })

  test('streams completed text parts and tool announcements live, before the node finishes', async () => {
    const chunks: string[] = []
    const exec: ExecFn = async (_file, _args, opts = {}) => {
      opts.onChunk?.(JSONL)
      return { stdout: JSONL, stderr: '', exitCode: 0 }
    }
    const res = await createOpencodeAdapter({ exec }).invoke({ prompt: 'p' }, (c) => chunks.push(c))
    expect(chunks).toEqual(['[using tool: edit]', 'Fixed the bug.'])
    expect(res.output).toBe('Fixed the bug.')
  })

  test('throws with the stderr tail on a nonzero exit (opencode sets exitCode 1 on session errors)', async () => {
    const exec: ExecFn = async () => ({ stdout: '', stderr: 'ProviderAuthError: no credentials', exitCode: 1 })
    await expect(createOpencodeAdapter({ exec }).invoke({ prompt: 'p' }))
      .rejects.toThrow(/opencode exited 1: .*ProviderAuthError/s)
  })
})
