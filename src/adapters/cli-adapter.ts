import { execa } from 'execa'
import type { Adapter, AgentRequest, AgentResult } from '../core/types.js'

export interface ExecResult {
  stdout: string
  stderr: string
  exitCode: number
}

export type ExecFn = (
  file: string,
  args: string[],
  opts?: { input?: string; timeoutMs?: number; cwd?: string },
) => Promise<ExecResult>

export const defaultExec: ExecFn = async (file, args, opts = {}) => {
  const res = await execa(file, args, {
    input: opts.input, timeout: opts.timeoutMs, cwd: opts.cwd, reject: false,
  })
  return {
    stdout: typeof res.stdout === 'string' ? res.stdout : '',
    stderr: typeof res.stderr === 'string' ? res.stderr : '',
    exitCode: res.exitCode ?? 1,
  }
}

export interface ParsedResponse {
  output: string
  costUsd?: number
  tokens?: number
}

export type ResponseParser = (stdout: string) => ParsedResponse

export interface CliAdapterOptions {
  name: string
  command: string     // whitespace-tokenized argv template; the token {prompt} becomes one arg
  stdin?: boolean     // pipe the prompt to stdin instead of substituting {prompt}
  parser?: ResponseParser
  exec?: ExecFn
  cwd?: string
  extraArgs?: (req: AgentRequest) => string[]  // per-request args appended after the template
}

export class CliAdapter implements Adapter {
  readonly name: string
  private readonly exec: ExecFn

  constructor(private readonly opts: CliAdapterOptions) {
    this.name = opts.name
    this.exec = opts.exec ?? defaultExec
    if (!opts.stdin && !opts.command.includes('{prompt}')) {
      throw new Error(
        `adapter "${opts.name}": command template must contain {prompt} or set stdin mode`,
      )
    }
  }

  async invoke(req: AgentRequest): Promise<AgentResult> {
    const started = Date.now()
    const tokens = this.opts.command.split(/\s+/).filter(Boolean)
    const [file, ...args] = tokens.map((t) => (t === '{prompt}' ? req.prompt : t))
    if (this.opts.extraArgs) args.push(...this.opts.extraArgs(req))
    const res = await this.exec(file, args, {
      input: this.opts.stdin ? req.prompt : undefined,
      timeoutMs: req.timeoutMs,
      cwd: this.opts.cwd,
    })
    if (res.exitCode !== 0) {
      throw new Error(
        `${this.name} exited ${res.exitCode}: ${(res.stderr || res.stdout).slice(-400)}`,
      )
    }
    const parsed = this.opts.parser?.(res.stdout) ?? { output: res.stdout.trim() }
    return {
      output: parsed.output,
      costUsd: parsed.costUsd ?? 0,
      tokens: parsed.tokens ?? 0,
      durationMs: Date.now() - started,
    }
  }
}
