import { describe, expect, test } from 'vitest'
import { CliAdapter, defaultExec, type ExecFn, type ExecResult, type PermissionRequest } from './cli-adapter.js'

function fakeExec(result: Partial<ExecResult> = {}) {
  const calls: { file: string; args: string[]; input?: string; timeoutMs?: number; env?: Record<string, string> }[] = []
  const exec: ExecFn = async (file, args, opts = {}) => {
    calls.push({ file, args, input: opts.input, timeoutMs: opts.timeoutMs, env: opts.env })
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

  // EFF-6: per-agent env (AgentDef.env) reaches the subprocess so one agent
  // can be pointed at a caching/optimizing proxy without a global env change.
  test('forwards per-request env to the exec layer', async () => {
    const { exec, calls } = fakeExec()
    const a = new CliAdapter({ name: 'x', command: 'mytool {prompt}', exec })
    await a.invoke({ prompt: 'p', env: { ANTHROPIC_BASE_URL: 'http://localhost:8787' } })
    expect(calls[0].env).toEqual({ ANTHROPIC_BASE_URL: 'http://localhost:8787' })
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

  test('estimatedCostUsd and split input/output tokens are distinct from real costUsd/tokens', async () => {
    const { exec } = fakeExec({ stdout: '{}' })
    const a = new CliAdapter({
      name: 'x', command: 'mytool {prompt}', exec,
      parser: () => ({
        output: 'hi',
        estimatedCostUsd: 0.0123,
        inputTokens: 100,
        outputTokens: 50,
        tokens: 150,
      }),
    })
    const res = await a.invoke({ prompt: 'p' })
    // costUsd stays a real, adapter-reported figure - 0 when no real cost was
    // ever reported by the parser - and must never be inferred from the
    // estimate. estimatedCostUsd is a wholly separate field.
    expect(res.costUsd).toBe(0)
    expect(res.estimatedCostUsd).toBe(0.0123)
    expect(res.inputTokens).toBe(100)
    expect(res.outputTokens).toBe(50)
    expect(res.tokens).toBe(150)
  })

  test('estimatedCostUsd/inputTokens/outputTokens are left undefined, not coerced to 0, when a parser omits them', async () => {
    const { exec } = fakeExec({ stdout: '{"answer":"hi","usd":0.5}' })
    const a = new CliAdapter({
      name: 'x', command: 'mytool {prompt}', exec,
      parser: (stdout) => {
        const j = JSON.parse(stdout) as { answer: string; usd: number }
        return { output: j.answer, costUsd: j.usd, tokens: 42 }
      },
    })
    const res = await a.invoke({ prompt: 'p' })
    expect(res.estimatedCostUsd).toBeUndefined()
    expect(res.inputTokens).toBeUndefined()
    expect(res.outputTokens).toBeUndefined()
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

  test('a streamHandler turns each raw stdout line into live-output text via handleLine', async () => {
    const chunks: string[] = []
    const exec: ExecFn = async (_file, _args, opts = {}) => {
      opts.onChunk?.('{"n":1}\n{"n":2}\n')
      opts.onChunk?.('{"n":3}\n')
      return { stdout: '', stderr: '', exitCode: 0 }
    }
    const streamHandler = (line: string) => {
      const n = (JSON.parse(line) as { n: number }).n
      return n % 2 === 0 ? null : `line ${n}`
    }
    const a = new CliAdapter({ name: 'x', command: 'mytool {prompt}', exec, streamHandler })
    await a.invoke({ prompt: 'p' }, (c) => chunks.push(c))
    expect(chunks).toEqual(['line 1', 'line 3'])
  })

  test('a streamHandler buffers a line split across two raw chunks', async () => {
    const chunks: string[] = []
    const exec: ExecFn = async (_file, _args, opts = {}) => {
      opts.onChunk?.('{"te')
      opts.onChunk?.('xt":"hi"}\n')
      return { stdout: '', stderr: '', exitCode: 0 }
    }
    const streamHandler = (line: string) => (JSON.parse(line) as { text: string }).text
    const a = new CliAdapter({ name: 'x', command: 'mytool {prompt}', exec, streamHandler })
    await a.invoke({ prompt: 'p' }, (c) => chunks.push(c))
    expect(chunks).toEqual(['hi'])
  })

  test('without onChunk, a streamHandler is never invoked (no wasted parsing)', async () => {
    let called = false
    const exec: ExecFn = async (_file, _args, opts = {}) => {
      expect(opts.onChunk).toBeUndefined()
      return { stdout: 'raw output', stderr: '', exitCode: 0 }
    }
    const streamHandler = (line: string) => { called = true; return line }
    const a = new CliAdapter({ name: 'x', command: 'mytool {prompt}', exec, streamHandler })
    await a.invoke({ prompt: 'p' })
    expect(called).toBe(false)
  })

  describe('permission detection seam', () => {
    test('a configured permissionDetector is passed through to exec, and a matching line surfaces a PermissionRequest to onPermission', async () => {
      const seen: PermissionRequest[] = []
      const exec: ExecFn = async (_file, _args, opts = {}) => {
        expect(opts.permissionDetector).toBeTypeOf('function')
        const req = opts.permissionDetector?.('Allow tool "write_file"? (y/n)')
        expect(req).not.toBeNull()
        if (req) await opts.onPermission?.(req)
        return { stdout: 'done', stderr: '', exitCode: 0 }
      }
      const permissionDetector = (line: string): PermissionRequest | null => {
        if (!line.startsWith('Allow tool')) return null
        return {
          question: line,
          answer: (approved) => (approved ? 'y\n' : 'n\n'),
        }
      }
      const a = new CliAdapter({ name: 'x', command: 'mytool {prompt}', exec, permissionDetector })
      await a.invoke({ prompt: 'p' }, undefined, async (req) => {
        seen.push(req)
        return true
      })
      expect(seen).toHaveLength(1)
      expect(seen[0].question).toBe('Allow tool "write_file"? (y/n)')
    })

    test('a non-matching line yields null from the detector', async () => {
      const exec: ExecFn = async (_file, _args, opts = {}) => {
        expect(opts.permissionDetector?.('just some ordinary output')).toBeNull()
        return { stdout: 'done', stderr: '', exitCode: 0 }
      }
      const permissionDetector = (line: string): PermissionRequest | null =>
        line.startsWith('Allow tool') ? { question: line, answer: () => 'y\n' } : null
      const a = new CliAdapter({ name: 'x', command: 'mytool {prompt}', exec, permissionDetector })
      await a.invoke({ prompt: 'p' })
    })

    test('no permissionDetector configured means exec receives undefined for it', async () => {
      const exec: ExecFn = async (_file, _args, opts = {}) => {
        expect(opts.permissionDetector).toBeUndefined()
        expect(opts.onPermission).toBeUndefined()
        return { stdout: 'done', stderr: '', exitCode: 0 }
      }
      const a = new CliAdapter({ name: 'x', command: 'mytool {prompt}', exec })
      await a.invoke({ prompt: 'p' })
    })
  })

  describe('defaultExec stdin behavior for permission relay', () => {
    test('with no permissionDetector, stdin stays closed/ignored: a child that waits for stdin EOF sees it immediately (no open, unfed pipe)', async () => {
      const script = `
        process.stdin.resume();
        process.stdin.on('end', () => { process.stdout.write('END'); process.exit(0); });
      `
      const res = await defaultExec(process.execPath, ['-e', script], { timeoutMs: 5000 })
      expect(res.exitCode).toBe(0)
      expect(res.stdout).toBe('END')
    })

    test('a configured permissionDetector opens a writable stdin, and writing an answer back reaches the exact in-flight subprocess', async () => {
      const script = `
        process.stdout.write('Allow tool "write_file"? (y/n)\\n');
        process.stdin.resume();
        process.stdin.setEncoding('utf8');
        let buf = '';
        process.stdin.on('data', (d) => {
          buf += d;
          if (buf.includes('\\n')) {
            process.stdout.write('GOT:' + buf);
            process.exit(0);
          }
        });
      `
      const receivedQuestions: string[] = []
      const permissionDetector = (line: string): PermissionRequest | null =>
        line.startsWith('Allow tool')
          ? { question: line, answer: (approved: boolean) => (approved ? 'y\n' : 'n\n') }
          : null
      const res = await defaultExec(process.execPath, ['-e', script], {
        timeoutMs: 5000,
        permissionDetector,
        onPermission: async (req) => {
          receivedQuestions.push(req.question)
          return true
        },
      })
      expect(receivedQuestions).toEqual(['Allow tool "write_file"? (y/n)'])
      expect(res.stdout).toContain('GOT:y')
      expect(res.exitCode).toBe(0)
    })

    test('a configured permissionDetector honors a denied answer, writing the deny bytes back', async () => {
      const script = `
        process.stdout.write('Allow tool "write_file"? (y/n)\\n');
        process.stdin.resume();
        process.stdin.setEncoding('utf8');
        let buf = '';
        process.stdin.on('data', (d) => {
          buf += d;
          if (buf.includes('\\n')) {
            process.stdout.write('GOT:' + buf);
            process.exit(0);
          }
        });
      `
      const permissionDetector = (line: string): PermissionRequest | null =>
        line.startsWith('Allow tool')
          ? { question: line, answer: (approved: boolean) => (approved ? 'y\n' : 'n\n') }
          : null
      const res = await defaultExec(process.execPath, ['-e', script], {
        timeoutMs: 5000,
        permissionDetector,
        onPermission: async () => false,
      })
      expect(res.stdout).toContain('GOT:n')
    })
  })
})
