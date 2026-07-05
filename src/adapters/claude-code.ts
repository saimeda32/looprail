import type { Adapter, AgentRequest } from '../core/types.js'
import { CliAdapter, type ExecFn, type ParsedResponse } from './cli-adapter.js'
import { resolvePermissionArgs } from './permissions.js'

interface ClaudeEnvelope {
  type?: string
  result?: unknown
  total_cost_usd?: unknown
  usage?: { input_tokens?: number; output_tokens?: number }
}

interface ClaudeContentBlock {
  type?: string
  text?: string
  name?: string
}

interface ClaudeStreamLine {
  type?: string
  message?: { content?: ClaudeContentBlock[] }
}

function extractResult(e: ClaudeEnvelope): ParsedResponse | null {
  if (typeof e.result !== 'string') return null
  const usage = e.usage ?? {}
  return {
    output: e.result,
    costUsd: typeof e.total_cost_usd === 'number' ? e.total_cost_usd : 0,
    tokens: (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0),
  }
}

// --output-format json's single envelope and --output-format stream-json's
// terminal `type: "result"` line share this exact shape, so both feed the
// same extraction logic - this just has to find the right line first.
export function parseClaudeJson(stdout: string): ParsedResponse {
  try {
    const parsed = extractResult(JSON.parse(stdout) as ClaudeEnvelope)
    if (parsed) return parsed
  } catch {
    // not a single JSON object - fall through to raw text
  }
  return { output: stdout.trim() }
}

// stream-json emits one JSON object per line as the turn progresses (a
// system init line, zero or more assistant messages, then a single result
// line with the final answer, cost, and usage) rather than one blob at
// process exit. Scan every line for the result line specifically - earlier
// lines are progress, handled separately by claudeStreamLine below, not the
// final answer.
export function parseClaudeStreamJsonl(stdout: string): ParsedResponse {
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue
    let e: ClaudeEnvelope
    try {
      e = JSON.parse(line) as ClaudeEnvelope
    } catch {
      continue
    }
    if (e.type === 'result') {
      const parsed = extractResult(e)
      if (parsed) return parsed
    }
  }
  return { output: stdout.trim() }
}

// Turns one line of the stream-json format into text worth showing live, or
// null. Claude Code's `-p` mode does not stream token-by-token even in this
// format (verified empirically: a multi-sentence reply still arrived as one
// complete text block, not incremental deltas) - but it does emit real
// progress before the final answer: a thinking indicator, tool-use
// summaries, then the complete text once it's ready. That is a genuine
// improvement over showing nothing at all until the process exits, which is
// what the old --output-format json command did unconditionally.
export function claudeStreamLine(line: string): string | null {
  let e: ClaudeStreamLine
  try {
    e = JSON.parse(line) as ClaudeStreamLine
  } catch {
    return null
  }
  if (e.type !== 'assistant') return null
  for (const block of e.message?.content ?? []) {
    if (block.type === 'text' && typeof block.text === 'string' && block.text.length > 0) {
      return block.text
    }
    if (block.type === 'tool_use' && typeof block.name === 'string') {
      return `[using tool: ${block.name}]`
    }
    if (block.type === 'thinking') {
      return '[thinking...]'
    }
  }
  return null
}

// No `permissionDetector` is wired here (see cli-adapter.ts's
// PermissionDetector seam). Investigated live against a real claude v2.1.199
// install with stdin closed, using this exact adapter's --permission-mode
// acceptEdits flag and also --disallowedTools Bash to try to force a hard
// denial: every attempt still ran the requested tool successfully - no
// blocked-prompt line was ever observed to build a detector against. The
// final stream-json `type:"result"` envelope does carry a `permission_denials`
// field, but it was empty ([]) in every run, so its populated shape is
// unconfirmed. Wiring a detector against a guessed shape would violate this
// project's "no invented prompt format" rule - deferred pending a fresh,
// un-configured claude install where a real denial can be captured.
export function createClaudeCodeAdapter(
  opts: { exec?: ExecFn; cwd?: string } = {},
): Adapter {
  return new CliAdapter({
    name: 'claude-code',
    command: 'claude -p {prompt} --output-format stream-json --verbose',
    extraArgs: (req: AgentRequest) => [
      ...(req.model ? ['--model', req.model] : []),
      ...resolvePermissionArgs(req.permissions, 'claude-code'),
    ],
    parser: parseClaudeStreamJsonl,
    streamHandler: claudeStreamLine,
    exec: opts.exec,
    cwd: opts.cwd,
  })
}
