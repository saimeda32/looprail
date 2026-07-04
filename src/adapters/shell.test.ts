import { describe, expect, test } from 'vitest'
import { createShellAdapter, shellQuote } from './shell.js'
import type { ExecFn } from './cli-adapter.js'

function fakeExec(stdout = 'shell says hi\n') {
  const calls: { file: string; args: string[]; input?: string }[] = []
  const exec: ExecFn = async (file, args, opts = {}) => {
    calls.push({ file, args, input: opts.input })
    return { stdout, stderr: '', exitCode: 0 }
  }
  return { exec, calls }
}

test('shellQuote survives embedded single quotes', () => {
  expect(shellQuote(`it's a "test"`)).toBe(`'it'\\''s a "test"'`)
})

describe('createShellAdapter', () => {
  test('substitutes {prompt} shell-quoted into the user command', async () => {
    const { exec, calls } = fakeExec()
    const a = createShellAdapter({ exec })
    const res = await a.invoke({ prompt: `say 'hi'`, command: 'mytool --ask {prompt}' })
    expect(calls[0].file).toBe('/bin/sh')
    expect(calls[0].args[0]).toBe('-c')
    expect(calls[0].args[1]).toBe(`mytool --ask 'say '\\''hi'\\'''`)
    expect(calls[0].input).toBeUndefined()
    expect(res).toMatchObject({ output: 'shell says hi', costUsd: 0, tokens: 0 })
  })

  test('substitutes {model} shell-quoted into the user command when the request specifies one', async () => {
    const { exec, calls } = fakeExec()
    await createShellAdapter({ exec }).invoke({ prompt: 'p', command: 'mytool --model {model} {prompt}', model: 'gpt-5.4' })
    expect(calls[0].args[1]).toBe(`mytool --model 'gpt-5.4' 'p'`)
  })

  test('substitutes {model} with an empty string when the request has none', async () => {
    const { exec, calls } = fakeExec()
    await createShellAdapter({ exec }).invoke({ prompt: 'p', command: 'mytool --model {model} {prompt}' })
    expect(calls[0].args[1]).toBe(`mytool --model '' 'p'`)
  })

  test('leaves the command untouched when it has no {model} placeholder at all', async () => {
    const { exec, calls } = fakeExec()
    await createShellAdapter({ exec }).invoke({ prompt: 'p', command: 'mytool {prompt}', model: 'gpt-5.4' })
    expect(calls[0].args[1]).toBe(`mytool 'p'`)
  })

  test('pipes the prompt to stdin when the template has no {prompt}', async () => {
    const { exec, calls } = fakeExec()
    await createShellAdapter({ exec }).invoke({ prompt: 'hello', command: 'mytool run' })
    expect(calls[0].args[1]).toBe('mytool run')
    expect(calls[0].input).toBe('hello')
  })

  test('throws a human-first error when the agent has no command', async () => {
    const { exec } = fakeExec()
    await expect(createShellAdapter({ exec }).invoke({ prompt: 'p' }))
      .rejects.toThrow(/agents\.<name>\.command/)
  })

  test('non-zero exit throws with output tail', async () => {
    const exec: ExecFn = async () => ({ stdout: '', stderr: 'kaboom', exitCode: 2 })
    await expect(createShellAdapter({ exec }).invoke({ prompt: 'p', command: 'x {prompt}' }))
      .rejects.toThrow(/kaboom/)
  })
})
