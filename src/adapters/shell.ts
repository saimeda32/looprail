import type { Adapter, AgentRequest, AgentResult } from '../core/types.js'
import { defaultExec, type ExecFn } from './cli-adapter.js'

export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

export function createShellAdapter(
  opts: { exec?: ExecFn; cwd?: string } = {},
): Adapter {
  const exec = opts.exec ?? defaultExec
  return {
    name: 'shell',
    async invoke(req: AgentRequest): Promise<AgentResult> {
      if (!req.command) {
        throw new Error(
          'shell adapter needs a command template - set agents.<name>.command in your loopfile',
        )
      }
      const started = Date.now()
      const substituted = req.command.includes('{prompt}')
      let rendered = substituted
        ? req.command.replaceAll('{prompt}', shellQuote(req.prompt))
        : req.command
      // A user's own model-aware CLI (any tool not covered by a built-in
      // adapter) still needs a way to receive agents.<name>.model - the
      // built-in adapters get this via a separate extraArgs mechanism, but
      // shell has no such hook, so the model substitutes inline instead.
      // Empty when unset, same permissive default {prompt} substitution uses.
      if (rendered.includes('{model}')) rendered = rendered.replaceAll('{model}', shellQuote(req.model ?? ''))
      const res = await exec('/bin/sh', ['-c', rendered], {
        input: substituted ? undefined : req.prompt,
        timeoutMs: req.timeoutMs,
        cwd: opts.cwd,
      })
      if (res.exitCode !== 0) {
        throw new Error(`shell exited ${res.exitCode}: ${(res.stderr || res.stdout).slice(-400)}`)
      }
      return { output: res.stdout.trim(), costUsd: 0, tokens: 0, durationMs: Date.now() - started }
    },
  }
}
