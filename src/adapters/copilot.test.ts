import { describe, expect, test } from 'vitest'
import { copilotStreamLine, createCopilotAdapter, parseCopilotJsonl } from './copilot.js'
import type { ExecFn } from './cli-adapter.js'

const JSONL = [
  JSON.stringify({ type: 'session.tools_updated', data: { model: 'claude-sonnet-5' } }),
  JSON.stringify({ type: 'assistant.message_delta', data: { deltaContent: 'h' } }),
  JSON.stringify({ type: 'assistant.message_delta', data: { deltaContent: 'i' } }),
  JSON.stringify({ type: 'assistant.message', data: { content: 'hi', outputTokens: 4 } }),
  JSON.stringify({ type: 'result', exitCode: 0 }),
].join('\n')

describe('parseCopilotJsonl', () => {
  test('takes the final assistant.message content and its output token count', () => {
    expect(parseCopilotJsonl(JSONL)).toEqual({
      output: 'hi',
      tokens: 4,
      outputTokens: 4,
      resolvedModel: 'claude-sonnet-5',
    })
  })

  test('falls back to raw text when no assistant.message line exists', () => {
    expect(parseCopilotJsonl('not json at all\n')).toEqual({ output: 'not json at all' })
  })

  test('ignores unparseable lines instead of throwing', () => {
    expect(parseCopilotJsonl('garbage\n' + JSONL)).toEqual({
      output: 'hi',
      tokens: 4,
      outputTokens: 4,
      resolvedModel: 'claude-sonnet-5',
    })
  })

  test('captures the resolved model from session.tools_updated even when AgentRequest.model was omitted/"auto"', () => {
    const jsonl = [
      JSON.stringify({ type: 'session.tools_updated', data: { model: 'gpt-5.4' } }),
      JSON.stringify({ type: 'assistant.message', data: { content: 'ok', outputTokens: 2 } }),
    ].join('\n')
    expect(parseCopilotJsonl(jsonl).resolvedModel).toBe('gpt-5.4')
  })

  test('leaves inputTokens undefined - copilot JSON never reports an input-token count anywhere (verified empirically)', () => {
    const parsed = parseCopilotJsonl(JSONL)
    expect(parsed.inputTokens).toBeUndefined()
    expect(parsed.outputTokens).toBe(4)
  })

  test('leaves resolvedModel undefined when no session.tools_updated event is present', () => {
    const jsonl = JSON.stringify({ type: 'assistant.message', data: { content: 'ok', outputTokens: 1 } })
    expect(parseCopilotJsonl(jsonl).resolvedModel).toBeUndefined()
  })
})

describe('copilotStreamLine', () => {
  test('surfaces a message_delta chunk verbatim', () => {
    const line = JSON.stringify({ type: 'assistant.message_delta', data: { deltaContent: 'lo' } })
    expect(copilotStreamLine(line)).toBe('lo')
  })

  test('ignores non-delta lines', () => {
    expect(copilotStreamLine(JSON.stringify({ type: 'assistant.message', data: { content: 'hi' } }))).toBeNull()
    expect(copilotStreamLine(JSON.stringify({ type: 'session.tools_updated' }))).toBeNull()
  })

  test('returns null for unparseable lines instead of throwing', () => {
    expect(copilotStreamLine('not json')).toBeNull()
  })
})

describe('createCopilotAdapter', () => {
  test('invokes copilot directly (not through gh) with JSON output and --allow-all-tools for non-interactive use', async () => {
    const calls: { file: string; args: string[] }[] = []
    const exec: ExecFn = async (file, args) => {
      calls.push({ file, args })
      return { stdout: JSONL, stderr: '', exitCode: 0 }
    }
    const res = await createCopilotAdapter({ exec }).invoke({ prompt: 'say hi' })
    expect(calls[0].file).toBe('copilot')
    expect(calls[0].args).toEqual([
      '-p', 'say hi', '--output-format', 'json', '--allow-all-tools',
      '--allow-all-tools', '--allow-all-paths', '--allow-all-urls',
    ])
    expect(res).toMatchObject({ output: 'hi', tokens: 4, costUsd: 0 })
  })

  test('appends --model when the request specifies one', async () => {
    const calls: string[][] = []
    const exec: ExecFn = async (_file, args) => {
      calls.push(args)
      return { stdout: JSONL, stderr: '', exitCode: 0 }
    }
    await createCopilotAdapter({ exec }).invoke({ prompt: 'say hi', model: 'gpt-5.4' })
    expect(calls[0]).toEqual([
      '-p', 'say hi', '--output-format', 'json', '--allow-all-tools', '--model', 'gpt-5.4',
      '--allow-all-tools', '--allow-all-paths', '--allow-all-urls',
    ])
  })

  test('omits --model when the request has none, but still applies the full default permission flags', async () => {
    const calls: string[][] = []
    const exec: ExecFn = async (_file, args) => {
      calls.push(args)
      return { stdout: JSONL, stderr: '', exitCode: 0 }
    }
    await createCopilotAdapter({ exec }).invoke({ prompt: 'say hi' })
    expect(calls[0]).toEqual([
      '-p', 'say hi', '--output-format', 'json', '--allow-all-tools',
      '--allow-all-tools', '--allow-all-paths', '--allow-all-urls',
    ])
  })

  test('appends permission flags after --model, resolved via resolvePermissionArgs', async () => {
    const calls: string[][] = []
    const exec: ExecFn = async (_file, args) => {
      calls.push(args)
      return { stdout: JSONL, stderr: '', exitCode: 0 }
    }
    await createCopilotAdapter({ exec }).invoke({ prompt: 'say hi', model: 'claude-sonnet-5', permissions: 'safe' })
    expect(calls[0]).toEqual([
      '-p', 'say hi', '--output-format', 'json', '--allow-all-tools', '--model', 'claude-sonnet-5',
      '--allow-tool', 'write', '--allow-tool', 'shell(npm:*)',
    ])
  })

  test('with no permissions config, still resolves to full (matching the pre-existing --allow-all-tools default)', async () => {
    const calls: string[][] = []
    const exec: ExecFn = async (_file, args) => {
      calls.push(args)
      return { stdout: JSONL, stderr: '', exitCode: 0 }
    }
    await createCopilotAdapter({ exec }).invoke({ prompt: 'say hi' })
    expect(calls[0]).toEqual([
      '-p', 'say hi', '--output-format', 'json', '--allow-all-tools',
      '--allow-all-tools', '--allow-all-paths', '--allow-all-urls',
    ])
  })

  test('streams each token delta live, before the node finishes', async () => {
    const chunks: string[] = []
    const exec: ExecFn = async (_file, _args, opts = {}) => {
      opts.onChunk?.(JSONL)
      return { stdout: JSONL, stderr: '', exitCode: 0 }
    }
    const res = await createCopilotAdapter({ exec }).invoke({ prompt: 'p' }, (c) => chunks.push(c))
    expect(chunks).toEqual(['h', 'i'])
    expect(res.output).toBe('hi')
  })

  test('estimates a cost from the resolved model + output tokens when the model is priced, without touching costUsd', async () => {
    const exec: ExecFn = async () => ({ stdout: JSONL, stderr: '', exitCode: 0 })
    const loadPricingTable = () => ({
      'claude-sonnet-5': { input_cost_per_token: 2e-6, output_cost_per_token: 1e-5 },
    })
    const res = await createCopilotAdapter({ exec, loadPricingTable }).invoke({ prompt: 'say hi' })
    // JSONL fixture: resolvedModel 'claude-sonnet-5' from session.tools_updated, outputTokens 4, no inputTokens.
    expect(res.costUsd).toBe(0)
    expect(res.estimatedCostUsd).toBeCloseTo(4 * 1e-5)
  })

  test('leaves estimatedCostUsd undefined (never 0) when the resolved model is absent from the pricing table', async () => {
    const exec: ExecFn = async () => ({ stdout: JSONL, stderr: '', exitCode: 0 })
    const res = await createCopilotAdapter({ exec, loadPricingTable: () => ({}) }).invoke({ prompt: 'say hi' })
    expect(res.costUsd).toBe(0)
    expect(res.estimatedCostUsd).toBeUndefined()
  })
})
