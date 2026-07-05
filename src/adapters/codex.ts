import type { Adapter, AgentRequest } from '../core/types.js'
import { CliAdapter, type ExecFn, type ParsedResponse } from './cli-adapter.js'
import { resolvePermissionArgs } from './permissions.js'

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
  // codex does not report USD cost in its envelope - costUsd stays 0 (default)
  return output ? { output, tokens } : { output: stdout.trim() }
}

// `codex exec --json` emits one line per completed item as the turn
// progresses, not one blob at the end - the same items parseCodexJsonl scans
// for above arrive live, so surfacing them as they land is a genuine
// incremental improvement, not just a re-announcement of the final output.
export function codexStreamLine(line: string): string | null {
  let e: CodexEvent
  try {
    e = JSON.parse(line) as CodexEvent
  } catch {
    return null
  }
  if (e.type !== 'item.completed' || !e.item?.text) return null
  if (e.item.type === 'agent_message') return e.item.text
  if (e.item.type === 'reasoning') return `[reasoning] ${e.item.text}`
  return null
}

export function createCodexAdapter(
  opts: { exec?: ExecFn; cwd?: string } = {},
): Adapter {
  return new CliAdapter({
    name: 'codex',
    command: 'codex exec --json {prompt}',
    extraArgs: (req: AgentRequest) => [
      ...(req.model ? ['-m', req.model] : []),
      ...resolvePermissionArgs(req.permissions, 'codex'),
    ],
    parser: parseCodexJsonl,
    streamHandler: codexStreamLine,
    exec: opts.exec,
    cwd: opts.cwd,
  })
}
