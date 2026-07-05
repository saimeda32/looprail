import { describe, expect, test } from 'vitest'
import { createAiderAdapter } from './aider.js'
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
})
