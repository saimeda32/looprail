import { describe, expect, test } from 'vitest'
import { createGeminiAdapter, geminiStreamLine, parseGeminiStreamJsonl } from './gemini.js'
import type { ExecFn } from './cli-adapter.js'

// Fixture mirrors the exact event shapes gemini-cli v0.49.0's own bundled
// source emits for `-o stream-json` (packages/core/src/output/
// stream-json-formatter.ts + packages/cli/src/nonInteractiveCli.ts): an init
// event with the resolved model, the user's echoed prompt, delta-streamed
// assistant message events, and a terminal result event whose stats carry
// snake_case aggregated token counts. Not captured from a live run - no
// Google credentials existed on the development machine (the CLI's flag
// surface and its stderr JSON error envelope WERE verified live; see
// gemini.ts).
const JSONL = [
  JSON.stringify({ type: 'init', timestamp: 't', session_id: 's1', model: 'gemini-2.5-pro' }),
  JSON.stringify({ type: 'message', timestamp: 't', role: 'user', content: 'say hi' }),
  JSON.stringify({ type: 'message', timestamp: 't', role: 'assistant', content: 'h', delta: true }),
  JSON.stringify({ type: 'message', timestamp: 't', role: 'assistant', content: 'i', delta: true }),
  JSON.stringify({
    type: 'result', timestamp: 't', status: 'success',
    stats: { total_tokens: 30, input_tokens: 20, output_tokens: 5, cached: 0, input: 0, duration_ms: 900, tool_calls: 0, models: {} },
  }),
].join('\n')

describe('parseGeminiStreamJsonl', () => {
  test('concatenates assistant deltas and takes the result stats token split', () => {
    expect(parseGeminiStreamJsonl(JSONL)).toEqual({
      output: 'hi',
      tokens: 30,
      inputTokens: 20,
      outputTokens: 5,
      resolvedModel: 'gemini-2.5-pro',
    })
  })

  test('captures the resolved model from the init event even when AgentRequest.model was omitted', () => {
    expect(parseGeminiStreamJsonl(JSONL).resolvedModel).toBe('gemini-2.5-pro')
    const noInit = JSON.stringify({ type: 'message', role: 'assistant', content: 'ok' })
    expect(parseGeminiStreamJsonl(noInit).resolvedModel).toBeUndefined()
  })

  test('prefers total_tokens over the input+output sum - it also counts thought/tool/cached tokens the split omits', () => {
    const parsed = parseGeminiStreamJsonl(JSONL)
    expect(parsed.tokens).toBe(30)
    expect(parsed.tokens).not.toBe((parsed.inputTokens ?? 0) + (parsed.outputTokens ?? 0))
  })

  test('never surfaces the echoed user message as output', () => {
    expect(parseGeminiStreamJsonl(JSONL).output).toBe('hi')
  })

  test('falls back to raw text when no assistant message line exists', () => {
    expect(parseGeminiStreamJsonl('not json at all\n')).toEqual({ output: 'not json at all' })
  })

  test('ignores unparseable lines instead of throwing', () => {
    expect(parseGeminiStreamJsonl('garbage\n' + JSONL).output).toBe('hi')
  })

  test('leaves tokens undefined (never 0) when no result event was emitted', () => {
    const jsonl = JSON.stringify({ type: 'message', role: 'assistant', content: 'ok', delta: true })
    const parsed = parseGeminiStreamJsonl(jsonl)
    expect(parsed.output).toBe('ok')
    expect(parsed.tokens).toBeUndefined()
    expect(parsed.inputTokens).toBeUndefined()
    expect(parsed.outputTokens).toBeUndefined()
  })

  test('never sets costUsd - gemini reports no dollar cost in any output format', () => {
    expect(parseGeminiStreamJsonl(JSONL).costUsd).toBeUndefined()
  })
})

describe('geminiStreamLine', () => {
  test('surfaces an assistant delta chunk verbatim', () => {
    const line = JSON.stringify({ type: 'message', role: 'assistant', content: 'lo', delta: true })
    expect(geminiStreamLine(line)).toBe('lo')
  })

  test('ignores the echoed user message and non-message events', () => {
    expect(geminiStreamLine(JSON.stringify({ type: 'message', role: 'user', content: 'say hi' }))).toBeNull()
    expect(geminiStreamLine(JSON.stringify({ type: 'init', model: 'gemini-2.5-pro' }))).toBeNull()
    expect(geminiStreamLine(JSON.stringify({ type: 'result', stats: {} }))).toBeNull()
  })

  test('announces tool use by name', () => {
    const line = JSON.stringify({ type: 'tool_use', tool_name: 'write_file', tool_id: '1', parameters: {} })
    expect(geminiStreamLine(line)).toBe('[using tool: write_file]')
  })

  test('returns null for unparseable lines instead of throwing', () => {
    expect(geminiStreamLine('not json')).toBeNull()
  })
})

describe('createGeminiAdapter', () => {
  test('invokes gemini -p with stream-json output and the safe default approval mode', async () => {
    const calls: { file: string; args: string[] }[] = []
    const exec: ExecFn = async (file, args) => {
      calls.push({ file, args })
      return { stdout: JSONL, stderr: '', exitCode: 0 }
    }
    const res = await createGeminiAdapter({ exec }).invoke({ prompt: 'say hi' })
    expect(calls[0].file).toBe('gemini')
    expect(calls[0].args).toEqual([
      '-p', 'say hi', '-o', 'stream-json', '--approval-mode', 'auto_edit',
    ])
    expect(res).toMatchObject({ output: 'hi', tokens: 30, costUsd: 0 })
  })

  test('appends --model before the permission flags when the request specifies one', async () => {
    const calls: string[][] = []
    const exec: ExecFn = async (_file, args) => {
      calls.push(args)
      return { stdout: JSONL, stderr: '', exitCode: 0 }
    }
    await createGeminiAdapter({ exec }).invoke({ prompt: 'say hi', model: 'gemini-2.5-flash', permissions: 'full' })
    expect(calls[0]).toEqual([
      '-p', 'say hi', '-o', 'stream-json', '--model', 'gemini-2.5-flash', '--approval-mode', 'yolo',
    ])
  })

  test('streams each assistant delta live, before the node finishes', async () => {
    const chunks: string[] = []
    const exec: ExecFn = async (_file, _args, opts = {}) => {
      opts.onChunk?.(JSONL)
      return { stdout: JSONL, stderr: '', exitCode: 0 }
    }
    const res = await createGeminiAdapter({ exec }).invoke({ prompt: 'p' }, (c) => chunks.push(c))
    expect(chunks).toEqual(['h', 'i'])
    expect(res.output).toBe('hi')
  })

  test('throws with the stderr tail on a nonzero exit - live-verified auth failures put a JSON error envelope there', async () => {
    const exec: ExecFn = async () => ({
      stdout: '',
      stderr: '{\n  "error": {\n    "type": "Error",\n    "message": "Please set an Auth method",\n    "code": 41\n  }\n}',
      exitCode: 41,
    })
    await expect(createGeminiAdapter({ exec }).invoke({ prompt: 'p' }))
      .rejects.toThrow(/gemini exited 41: .*Please set an Auth method/s)
  })

  test('estimates a mixed-rate cost from the resolved model + split tokens, without touching costUsd', async () => {
    const exec: ExecFn = async () => ({ stdout: JSONL, stderr: '', exitCode: 0 })
    const loadPricingTable = () => ({
      'gemini-2.5-pro': { input_cost_per_token: 2e-6, output_cost_per_token: 1e-5 },
    })
    // No AgentRequest.model pin - the estimate must come from the init
    // event's resolved model.
    const res = await createGeminiAdapter({ exec, loadPricingTable }).invoke({ prompt: 'say hi' })
    expect(res.costUsd).toBe(0)
    expect(res.estimatedCostUsd).toBeCloseTo(20 * 2e-6 + 5 * 1e-5)
  })

  test('leaves estimatedCostUsd undefined (never 0) when the model is absent from the pricing table', async () => {
    const exec: ExecFn = async () => ({ stdout: JSONL, stderr: '', exitCode: 0 })
    const res = await createGeminiAdapter({ exec, loadPricingTable: () => ({}) }).invoke({ prompt: 'say hi' })
    expect(res.costUsd).toBe(0)
    expect(res.estimatedCostUsd).toBeUndefined()
  })
})
