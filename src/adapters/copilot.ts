import type { Adapter, AgentRequest } from '../core/types.js'
import { CliAdapter, type ExecFn, type ParsedResponse } from './cli-adapter.js'
import { resolvePermissionArgs } from './permissions.js'

interface CopilotEvent {
  type?: string
  data?: { content?: string; deltaContent?: string; outputTokens?: number }
}

// `gh copilot -p ... --output-format json` emits one JSON object per line:
// session/tool bookkeeping, an assistant.message_delta per token as the
// reply is generated, a final assistant.message with the complete content
// and its own output token count, then a result line. It reports no dollar
// cost anywhere in this format - costUsd stays 0 (default).
export function parseCopilotJsonl(stdout: string): ParsedResponse {
  let output = ''
  let tokens = 0
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue
    let e: CopilotEvent
    try {
      e = JSON.parse(line) as CopilotEvent
    } catch {
      continue
    }
    if (e.type === 'assistant.message' && typeof e.data?.content === 'string') {
      output = e.data.content
      tokens = e.data.outputTokens ?? 0
    }
  }
  return output ? { output, tokens } : { output: stdout.trim() }
}

// Unlike claude-code and codex, gh copilot's JSON mode streams genuine
// per-token deltas (verified empirically), not just per-item snapshots -
// assistant.message_delta.deltaContent is the actual next slice of text.
export function copilotStreamLine(line: string): string | null {
  let e: CopilotEvent
  try {
    e = JSON.parse(line) as CopilotEvent
  } catch {
    return null
  }
  if (e.type === 'assistant.message_delta' && typeof e.data?.deltaContent === 'string') {
    return e.data.deltaContent
  }
  return null
}

// Best-effort adapter over the gh copilot extension, exercised for real only
// behind LOOPRAIL_LIVE=1 - CI never shells out to gh. --allow-all-tools is
// required for non-interactive use per `gh copilot -- --help`; without it,
// any tool call (writing a file, running a command) has nothing to prompt
// for approval and the model just declines or describes what it would do.
export function createCopilotAdapter(
  opts: { exec?: ExecFn; cwd?: string } = {},
): Adapter {
  return new CliAdapter({
    name: 'copilot-cli',
    command: 'gh copilot -p {prompt} --output-format json --allow-all-tools',
    // `gh copilot -- --help`: "--model <model> Set the AI model to use
    // (use 'auto' to let Copilot pick automatically)" - same shape as
    // claude-code/codex's own model pin, verified against the real CLI.
    extraArgs: (req: AgentRequest) => [
      ...(req.model ? ['--model', req.model] : []),
      ...resolvePermissionArgs(req.permissions, 'copilot-cli'),
    ],
    parser: parseCopilotJsonl,
    streamHandler: copilotStreamLine,
    exec: opts.exec,
    cwd: opts.cwd,
  })
}
