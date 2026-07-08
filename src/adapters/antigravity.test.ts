import { describe, expect, test } from 'vitest'
import { createAntigravityAdapter } from './antigravity.js'
import type { ExecFn } from './cli-adapter.js'
import type { PricingTable } from '../core/pricing.js'

const table: PricingTable = {
  'gemini-3.1-pro': { input_cost_per_token: 2e-6, output_cost_per_token: 8e-6 },
}

const fakeExec = (stdout: string, capture?: { file?: string; args?: string[]; input?: string }[]): ExecFn =>
  async (file, args, opts = {}) => {
    capture?.push({ file, args, input: opts.input })
    return { stdout, stderr: '', exitCode: 0 }
  }

describe('createAntigravityAdapter', () => {
  test('invokes agy -p <prompt> with the model pinned via -m', async () => {
    const calls: { file?: string; args?: string[] }[] = []
    const adapter = createAntigravityAdapter({ exec: fakeExec('done.\n', calls) })
    const res = await adapter.invoke({ prompt: 'fix the bug', model: 'gemini-3.1-pro' })
    expect(calls[0].file).toBe('agy')
    expect(calls[0].args).toEqual(['-p', 'fix the bug', '-m', 'gemini-3.1-pro'])
    expect(res.output).toBe('done.')
  })

  test('omitted model omits -m entirely (CLI default stands)', async () => {
    const calls: { args?: string[] }[] = []
    await createAntigravityAdapter({ exec: fakeExec('ok', calls) }).invoke({ prompt: 'p' })
    expect(calls[0].args).toEqual(['-p', 'p'])
  })

  test('permission presets map: safe sandboxes, full skips permissions', async () => {
    const calls: { args?: string[] }[] = []
    const adapter = createAntigravityAdapter({ exec: fakeExec('ok', calls) })
    await adapter.invoke({ prompt: 'p', permissions: { preset: 'safe' } })
    await adapter.invoke({ prompt: 'p', permissions: { preset: 'full' } })
    expect(calls[0].args).toContain('--sandbox')
    expect(calls[1].args).toContain('--dangerously-skip-permissions')
  })

  test('tokens are chars/4 ESTIMATES on both sides and cost is an estimate, never adapter-reported', async () => {
    const adapter = createAntigravityAdapter({
      exec: fakeExec('x'.repeat(400)),
      loadPricingTable: () => table,
    })
    const res = await adapter.invoke({ prompt: 'y'.repeat(800), model: 'gemini-3.1-pro' })
    expect(res.inputTokens).toBe(200)  // 800/4
    expect(res.outputTokens).toBe(100) // 400/4
    expect(res.costUsd).toBe(0) // agy print mode reports no dollars - real cost stays 0
    // (200/1e6)*2 + (100/1e6)*8 = 0.0004 + 0.0008
    expect(res.estimatedCostUsd).toBeCloseTo(0.0012, 6)
  })

  test('unknown model in the pricing table leaves estimatedCostUsd unset, not 0', async () => {
    const adapter = createAntigravityAdapter({
      exec: fakeExec('out'),
      loadPricingTable: () => table,
    })
    const res = await adapter.invoke({ prompt: 'p', model: 'mystery-model' })
    expect(res.estimatedCostUsd).toBeUndefined()
  })

  test('nonzero exit throws with stderr context', async () => {
    const exec: ExecFn = async () => ({ stdout: '', stderr: 'not logged in', exitCode: 41 })
    await expect(createAntigravityAdapter({ exec }).invoke({ prompt: 'p' }))
      .rejects.toThrow(/41.*not logged in/s)
  })

  test('raw chunks stream through (plain prose stdout, no envelope)', async () => {
    const exec: ExecFn = async (_f, _a, opts = {}) => {
      opts.onChunk?.('part1 ')
      opts.onChunk?.('part2')
      return { stdout: 'part1 part2', stderr: '', exitCode: 0 }
    }
    const chunks: string[] = []
    await createAntigravityAdapter({ exec }).invoke({ prompt: 'p' }, (c) => chunks.push(c))
    expect(chunks).toEqual(['part1 ', 'part2'])
  })
})
