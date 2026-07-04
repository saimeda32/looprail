import type { Adapter, AgentRequest } from '../core/types.js'
import { CliAdapter, type ExecFn, type ParsedResponse } from './cli-adapter.js'

interface ClaudeEnvelope {
  result?: unknown
  total_cost_usd?: unknown
  usage?: { input_tokens?: number; output_tokens?: number }
}

export function parseClaudeJson(stdout: string): ParsedResponse {
  try {
    const e = JSON.parse(stdout) as ClaudeEnvelope
    if (typeof e.result === 'string') {
      const usage = e.usage ?? {}
      return {
        output: e.result,
        costUsd: typeof e.total_cost_usd === 'number' ? e.total_cost_usd : 0,
        tokens: (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0),
      }
    }
  } catch {
    // not JSON - fall through to raw text
  }
  return { output: stdout.trim() }
}

export function createClaudeCodeAdapter(
  opts: { exec?: ExecFn; cwd?: string } = {},
): Adapter {
  return new CliAdapter({
    name: 'claude-code',
    command: 'claude -p {prompt} --output-format json',
    extraArgs: (req: AgentRequest) => (req.model ? ['--model', req.model] : []),
    parser: parseClaudeJson,
    exec: opts.exec,
    cwd: opts.cwd,
  })
}
