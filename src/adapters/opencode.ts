import type { Adapter, AgentRequest } from '../core/types.js'
import { CliAdapter, type ExecFn, type ParsedResponse } from './cli-adapter.js'
import { resolvePermissionArgs } from './permissions.js'

interface OpencodePart {
  id?: string
  type?: string
  text?: string
  tool?: string
  cost?: number
  tokens?: {
    input?: number
    output?: number
    reasoning?: number
    cache?: { read?: number; write?: number }
  }
  time?: { start?: number; end?: number }
}

interface OpencodeEvent {
  type?: string
  part?: OpencodePart
}

// `opencode run <message> --format json` emits one JSON object per line of
// the shape { type, timestamp, sessionID, part } (or { ..., error }). What
// was verifiable on this machine, and how: the flag surface (--model,
// --format json, --auto) comes from the real `opencode run --help` of
// v1.17.14, run live via npx. The event stream itself could NOT be observed
// live (no opencode provider credentials on this machine) - the shapes below
// are taken from that exact version's published source instead
// (packages/opencode/src/cli/cmd/run.ts's emit() calls and the SDK's
// generated part types in packages/sdk/js/src/v2/gen/types.gen.ts):
//   - `text` events fire once per *completed* assistant text part
//     (part.time.end set), each carrying the full part text - snapshots
//     like codex's items, not per-token deltas.
//   - `step_finish` events carry part.cost (opencode's own models.dev-priced
//     dollar figure for that step) and part.tokens
//     { input, output, reasoning, cache: { read, write } }.
//   - `tool_use`, `step_start`, `reasoning`, and `error` events also exist;
//     only tool_use is surfaced (via opencodeStreamLine), the rest carry
//     nothing this adapter needs.
// part.cost is mapped to costUsd - a judgment call worth being explicit
// about: like claude-code's total_cost_usd (which this repo already treats
// as adapter-reported), it is computed client-side by the CLI from its own
// pricing data and reported unconditionally in its wire format, unlike
// aider's "Cost:" line which only appears when aider recognizes the model
// and is therefore deliberately ignored over in aider.ts. Because a real
// cost is reported, no pricing estimator is wired in - same
// no-competing-estimate rule as claude-code.
export function parseOpencodeJsonl(stdout: string): ParsedResponse {
  const textById = new Map<string, string>()
  let sawUsage = false
  let costUsd = 0
  let inputTokens = 0
  let outputTokens = 0
  let anonymousCounter = 0
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue
    let e: OpencodeEvent
    try {
      e = JSON.parse(line) as OpencodeEvent
    } catch {
      continue
    }
    if (e.type === 'text' && typeof e.part?.text === 'string') {
      // Keyed by part id (last snapshot of a part wins) purely as a guard
      // against the same completed part being re-emitted; distinct parts
      // join below in arrival order, mirroring how the CLI's own non-TTY
      // default mode prints each completed text part on its own line.
      textById.set(e.part.id ?? `anon-${anonymousCounter++}`, e.part.text)
    }
    if (e.type === 'step_finish' && e.part) {
      sawUsage = true
      costUsd += e.part.cost ?? 0
      const t = e.part.tokens
      // cache read/write tokens are input-side context the provider actually
      // processed; reasoning tokens are output-side. Folded into the split
      // accordingly so the totals mean "all tokens billed", matching what
      // part.cost was computed over.
      inputTokens += (t?.input ?? 0) + (t?.cache?.read ?? 0) + (t?.cache?.write ?? 0)
      outputTokens += (t?.output ?? 0) + (t?.reasoning ?? 0)
    }
  }
  const output = [...textById.values()].join('\n').trim()
  if (!output) return { output: stdout.trim() }
  if (!sawUsage) return { output }
  return { output, costUsd, tokens: inputTokens + outputTokens, inputTokens, outputTokens }
}

// text events only fire once a part completes (see parseOpencodeJsonl) -
// surfacing them live is snapshot streaming like codex's item.completed,
// still a genuine improvement over silence until process exit.
export function opencodeStreamLine(line: string): string | null {
  let e: OpencodeEvent
  try {
    e = JSON.parse(line) as OpencodeEvent
  } catch {
    return null
  }
  if (e.type === 'text' && typeof e.part?.text === 'string' && e.part.text.length > 0) {
    return e.part.text
  }
  if (e.type === 'tool_use' && typeof e.part?.tool === 'string') {
    return `[using tool: ${e.part.tool}]`
  }
  return null
}

// No `permissionDetector` is wired here (see cli-adapter.ts's
// PermissionDetector seam) - and per the v1.17.14 run.ts source none is
// possible: non-interactive opencode never blocks on stdin for a permission
// answer. It resolves permission.asked events itself (approve-once under
// --auto, auto-reject otherwise), so there is no prompt moment to detect.
export function createOpencodeAdapter(
  opts: { exec?: ExecFn; cwd?: string } = {},
): Adapter {
  return new CliAdapter({
    name: 'opencode',
    command: 'opencode run {prompt} --format json',
    // `opencode run --help` (v1.17.14, live): "-m, --model  model to use in
    // the format of provider/model" - note the provider/ prefix, unlike
    // every other adapter's bare model string.
    extraArgs: (req: AgentRequest) => [
      ...(req.model ? ['--model', req.model] : []),
      ...resolvePermissionArgs(req.permissions, 'opencode'),
    ],
    parser: parseOpencodeJsonl,
    streamHandler: opencodeStreamLine,
    exec: opts.exec,
    cwd: opts.cwd,
  })
}
