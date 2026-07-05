import { describe, expect, test } from 'vitest'
import { createAiderAdapter, parseAiderOutput } from './aider.js'
import type { ExecFn } from './cli-adapter.js'

describe('createAiderAdapter', () => {
  test('invokes aider --message with per-request --model', async () => {
    const calls: { file: string; args: string[] }[] = []
    const exec: ExecFn = async (file, args) => {
      calls.push({ file, args })
      return { stdout: 'done', stderr: '', exitCode: 0 }
    }
    await createAiderAdapter({ exec }).invoke({ prompt: 'fix it', model: 'gpt-5' })
    expect(calls[0].file).toBe('aider')
    expect(calls[0].args).toEqual([
      '--message', 'fix it', '--yes-always', '--no-auto-commits', '--no-stream', '--no-pretty', '--model', 'gpt-5',
    ])
  })

  test('permissions config never adds any flags - aider has no finer granularity than its own hardcoded --yes-always', async () => {
    const calls: string[][] = []
    const exec: ExecFn = async (_f, args) => {
      calls.push(args)
      return { stdout: '', stderr: '', exitCode: 0 }
    }
    await createAiderAdapter({ exec }).invoke({ prompt: 'p', permissions: 'full' })
    expect(calls[0]).toEqual([
      '--message', 'p', '--yes-always', '--no-auto-commits', '--no-stream', '--no-pretty',
    ])
  })

  // Fixture below is the literal line format aider (v0.86.2) writes via
  // InputOutput.tool_output(self.usage_report) in
  // Coder.calculate_and_show_tokens_and_cost (aider/coders/base_coder.py):
  //   tokens_report = f"Tokens: {format_tokens(sent)} sent...{format_tokens(received)} received."
  // tool_output() always calls console.print for this line regardless of
  // --no-pretty (that flag only disables ANSI styling, verified in
  // aider/io.py InputOutput.tool_output) or --no-stream (streaming only
  // affects the assistant's live reply rendering, not this end-of-turn
  // summary, verified in the same source file). No aider flag suppresses
  // this line short of --quiet, which the adapter does not pass.
  test('parseAiderOutput extracts sent/received tokens from the real "Tokens:" summary line', () => {
    const stdout = [
      'Some assistant reply text here.',
      '',
      'Tokens: 116 sent, 30 received.',
    ].join('\n')
    const parsed = parseAiderOutput(stdout)
    expect(parsed.inputTokens).toBe(116)
    expect(parsed.outputTokens).toBe(30)
    expect(parsed.tokens).toBe(146)
    expect(parsed.costUsd).toBeUndefined()
  })

  test('parseAiderOutput handles the abbreviated "k" token format for large sessions', () => {
    // format_tokens() in aider/utils.py rounds/abbreviates counts >= 1000 to
    // e.g. "1.2k" - precision below the hundreds digit is genuinely lost in
    // aider's own output, not something this parser can recover.
    const stdout = 'Tokens: 1.2k sent, 3k received.'
    const parsed = parseAiderOutput(stdout)
    expect(parsed.inputTokens).toBe(1200)
    expect(parsed.outputTokens).toBe(3000)
    expect(parsed.tokens).toBe(4200)
  })

  test('parseAiderOutput leaves tokens undefined (never 0) when no Tokens: line is present', () => {
    // Verified finding: the summary line only appears after a real
    // completion carries usage - a run with no such line (e.g. no model
    // configured, or aider errored before completing a turn) genuinely has
    // no token count to report; treating that as 0 would falsely claim
    // "zero tokens used" instead of "unknown".
    const parsed = parseAiderOutput('Just some plain reply with no summary line.')
    expect(parsed.output).toBe('Just some plain reply with no summary line.')
    expect(parsed.inputTokens).toBeUndefined()
    expect(parsed.outputTokens).toBeUndefined()
    expect(parsed.tokens).toBeUndefined()
    expect(parsed.costUsd).toBeUndefined()
  })

  test('parseAiderOutput strips the Tokens: summary line out of the visible output', () => {
    const stdout = ['Fixed the bug in foo.py.', 'Tokens: 50 sent, 10 received.'].join('\n')
    const parsed = parseAiderOutput(stdout)
    expect(parsed.output).toBe('Fixed the bug in foo.py.')
  })

  test('createAiderAdapter wires parseAiderOutput in - real invoke result carries split tokens, costUsd stays 0', async () => {
    const exec: ExecFn = async () => ({
      stdout: 'Done.\nTokens: 200 sent, 50 received.',
      stderr: '',
      exitCode: 0,
    })
    const result = await createAiderAdapter({ exec }).invoke({ prompt: 'fix it' })
    expect(result.output).toBe('Done.')
    expect(result.inputTokens).toBe(200)
    expect(result.outputTokens).toBe(50)
    expect(result.tokens).toBe(250)
    expect(result.costUsd).toBe(0)
  })

  test('estimates a mixed-rate cost from the pinned model + split tokens, without touching costUsd', async () => {
    const exec: ExecFn = async () => ({
      stdout: 'Done.\nTokens: 200 sent, 50 received.',
      stderr: '',
      exitCode: 0,
    })
    const loadPricingTable = () => ({
      'claude-sonnet-5': { input_cost_per_token: 2e-6, output_cost_per_token: 1e-5 },
    })
    const result = await createAiderAdapter({ exec, loadPricingTable }).invoke({
      prompt: 'fix it', model: 'claude-sonnet-5',
    })
    expect(result.costUsd).toBe(0)
    expect(result.estimatedCostUsd).toBeCloseTo(200 * 2e-6 + 50 * 1e-5)
  })

  test('leaves estimatedCostUsd undefined (never 0) when no Tokens: line was present to price', async () => {
    const exec: ExecFn = async () => ({ stdout: 'Just plain text, no summary line.', stderr: '', exitCode: 0 })
    const result = await createAiderAdapter({
      exec, loadPricingTable: () => ({ 'claude-sonnet-5': { input_cost_per_token: 2e-6, output_cost_per_token: 1e-5 } }),
    }).invoke({ prompt: 'fix it', model: 'claude-sonnet-5' })
    expect(result.costUsd).toBe(0)
    expect(result.estimatedCostUsd).toBeUndefined()
  })
})
