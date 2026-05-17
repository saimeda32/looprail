import type { Adapter, AgentRequest } from '../core/types.js'
import { CliAdapter, type ExecFn, type ParsedResponse } from './cli-adapter.js'

interface CodexEvent {
  type?: string
  item?: { type?: string; text?: string }
  usage?: { input_tokens?: number; output_tokens?: number }
}

export function parseCodexJsonl(stdout: string): ParsedResponse {
  let output = ''
  let tokens = 0
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue
    let e: CodexEvent
    try {
      e = JSON.parse(line) as CodexEvent
    } catch {
      continue
    }
    if (e.type === 'item.completed' && e.item?.type === 'agent_message' && e.item.text) {
      output = e.item.text
    }
    if (e.type === 'turn.completed' && e.usage) {
      tokens = (e.usage.input_tokens ?? 0) + (e.usage.output_tokens ?? 0)
    }
  }
  // codex does not report USD cost in its envelope — costUsd stays 0 (default)
  return output ? { output, tokens } : { output: stdout.trim() }
}

export function createCodexAdapter(
  opts: { exec?: ExecFn; cwd?: string } = {},
): Adapter {
  return new CliAdapter({
    name: 'codex',
    command: 'codex exec --json {prompt}',
    extraArgs: (req: AgentRequest) => (req.model ? ['-m', req.model] : []),
    parser: parseCodexJsonl,
    exec: opts.exec,
    cwd: opts.cwd,
  })
}
