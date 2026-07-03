import { describe, expect, test } from 'vitest'
import { CliAdapter, type ExecFn, type ExecResult } from './cli-adapter.js'

function fakeExec(result: Partial<ExecResult> = {}) {
  const calls: { file: string; args: string[]; input?: string; timeoutMs?: number }[] = []
  const exec: ExecFn = async (file, args, opts = {}) => {
    calls.push({ file, args, input: opts.input, timeoutMs: opts.timeoutMs })
    return { stdout: 'raw output\n', stderr: '', exitCode: 0, ...result }
  }
  return { exec, calls }
}

describe('CliAdapter', () => {
  test('substitutes {prompt} as a single argv element', async () => {
    const { exec, calls } = fakeExec()
    const a = new CliAdapter({ name: 'x', command: 'mytool -p {prompt} --json', exec })
    const res = await a.invoke({ prompt: 'do the thing' })
    expect(calls[0]).toMatchObject({ file: 'mytool', args: ['-p', 'do the thing', '--json'] })
    expect(res).toMatchObject({ output: 'raw output', costUsd: 0, tokens: 0 })
    expect(res.durationMs).toBeGreaterThanOrEqual(0)
  })

  test('stdin mode pipes the prompt instead of substituting', async () => {
    const { exec, calls } = fakeExec()
    const a = new CliAdapter({ name: 'x', command: 'mytool run', stdin: true, exec })
    await a.invoke({ prompt: 'hello' })
    expect(calls[0]).toMatchObject({ file: 'mytool', args: ['run'], input: 'hello' })
  })

  test('forwards timeoutMs to the exec layer', async () => {
    const { exec, calls } = fakeExec()
    const a = new CliAdapter({ name: 'x', command: 'mytool {prompt}', exec })
    await a.invoke({ prompt: 'p', timeoutMs: 5000 })
    expect(calls[0].timeoutMs).toBe(5000)
  })

  test('parser maps stdout to output/cost/tokens', async () => {
    const { exec } = fakeExec({ stdout: '{"answer":"hi","usd":0.5}' })
    const a = new CliAdapter({
      name: 'x', command: 'mytool {prompt}', exec,
      parser: (stdout) => {
        const j = JSON.parse(stdout) as { answer: string; usd: number }
        return { output: j.answer, costUsd: j.usd, tokens: 42 }
      },
    })
    expect(await a.invoke({ prompt: 'p' })).toMatchObject({ output: 'hi', costUsd: 0.5, tokens: 42 })
  })

  test('non-zero exit throws with stderr tail', async () => {
    const { exec } = fakeExec({ exitCode: 1, stderr: 'rate limit exceeded' })
    const a = new CliAdapter({ name: 'x', command: 'mytool {prompt}', exec })
    await expect(a.invoke({ prompt: 'p' })).rejects.toThrow(/rate limit exceeded/)
  })

  test('rejects a template with neither {prompt} nor stdin mode', () => {
    expect(() => new CliAdapter({ name: 'x', command: 'mytool run' })).toThrow(/\{prompt\}/)
  })

  test('onChunk receives streamed stdout chunks as they arrive from exec', async () => {
    const chunks: string[] = []
    const exec: ExecFn = async (_file, _args, opts = {}) => {
      opts.onChunk?.('partial ')
      opts.onChunk?.('output')
      return { stdout: 'partial output', stderr: '', exitCode: 0 }
    }
    const a = new CliAdapter({ name: 'x', command: 'mytool {prompt}', exec })
    await a.invoke({ prompt: 'p' }, (c) => chunks.push(c))
    expect(chunks).toEqual(['partial ', 'output'])
  })

  test('invoke without an onChunk callback works exactly as before (backward compatible)', async () => {
    const { exec, calls } = fakeExec()
    const a = new CliAdapter({ name: 'x', command: 'mytool {prompt}', exec })
    const res = await a.invoke({ prompt: 'p' })
    expect(res.output).toBe('raw output')
    expect(calls[0]).toMatchObject({ file: 'mytool', args: ['p'] })
  })
})
