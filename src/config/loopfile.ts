import { parse } from 'yaml'
import type { AgentDef, LoopDef, NodeDef, Rails, Role, VerdictPolicy } from '../core/types.js'

const VALID_ROLES: readonly Role[] = [
  'planner', 'critic', 'executor', 'tester', 'judge', 'gate', 'synthesizer',
]

function isPositiveNumber(value: unknown): value is number {
  return typeof value === 'number' && value > 0
}

export function parseLoopfile(text: string): LoopDef {
  const raw = parse(text) as Record<string, unknown>
  const problems: string[] = []
  for (const field of ['name', 'goal', 'agents', 'graph', 'rails']) {
    if (raw?.[field] === undefined) problems.push(`missing required field "${field}"`)
  }
  if (problems.length > 0) throw new Error(`invalid loopfile:\n${problems.join('\n')}`)

  const graph = raw.graph as Record<string, Record<string, unknown>>
  const rawRails = raw.rails as Record<string, number>

  if (!isPositiveNumber(rawRails.max_iterations)) {
    problems.push('rails.max_iterations must be a positive number')
  }
  if (!isPositiveNumber(rawRails.max_cost_usd)) {
    problems.push('rails.max_cost_usd must be a positive number')
  }
  // A non-numeric or non-positive concurrency collapses the scheduler's worker
  // pool to zero (Math.floor(NaN) => NaN => zero workers), silently producing a
  // run where no node ever executes. Reject it here instead.
  if (raw.concurrency !== undefined && !isPositiveNumber(raw.concurrency)) {
    problems.push('concurrency must be a positive number')
  }
  // Stall detection compares trailing fingerprints for repetition, which needs
  // at least two iterations to have happened. stall_after: 1 would "stall" after
  // the first iteration, before any repetition could exist - reject it.
  if (rawRails.stall_after !== undefined
      && !(typeof rawRails.stall_after === 'number' && rawRails.stall_after >= 2)) {
    problems.push('rails.stall_after must be at least 2 (stall detection needs two iterations to compare)')
  }
  for (const [id, n] of Object.entries(graph)) {
    if (!VALID_ROLES.includes(n.role as Role)) {
      problems.push(`node "${id}": missing or invalid role "${n.role}"`)
    }
  }

  const rawVerdict = (raw.verdict as { policy?: unknown } | undefined)?.policy
  let verdictPolicy: VerdictPolicy = { kind: 'all-pass' }
  if (rawVerdict === undefined || rawVerdict === 'all-pass') {
    verdictPolicy = { kind: 'all-pass' }
  } else if (
    rawVerdict && typeof rawVerdict === 'object' && 'quorum' in rawVerdict
    && isPositiveNumber((rawVerdict as { quorum: unknown }).quorum)
  ) {
    verdictPolicy = { kind: 'quorum', atLeast: (rawVerdict as { quorum: number }).quorum }
  } else if (
    rawVerdict && typeof rawVerdict === 'object' && 'weighted' in rawVerdict
    && typeof (rawVerdict as { weighted: unknown }).weighted === 'number'
    && (rawVerdict as { weighted: number }).weighted > 0
    && (rawVerdict as { weighted: number }).weighted <= 1
  ) {
    verdictPolicy = { kind: 'weighted', threshold: (rawVerdict as { weighted: number }).weighted }
  } else {
    problems.push('verdict.policy must be "all-pass", { quorum: N }, or { weighted: 0..1 }')
  }

  if (problems.length > 0) throw new Error(`invalid loopfile:\n${problems.join('\n')}`)

  const nodes: NodeDef[] = parseGraphNodes(graph)

  return {
    name: raw.name as string,
    goal: raw.goal as string,
    agents: raw.agents as LoopDef['agents'],
    nodes,
    rails: {
      maxIterations: rawRails.max_iterations,
      maxCostUsd: rawRails.max_cost_usd,
      ...parseRailsPartial(rawRails),
    },
    verdictPolicy,
    ...(raw.concurrency !== undefined ? { concurrency: raw.concurrency as number } : {}),
  }
}

export function parseGraphNodes(graph: Record<string, Record<string, unknown>>): NodeDef[] {
  return Object.entries(graph).map(([id, n]) => {
    const after = n.after === undefined
      ? undefined
      : Array.isArray(n.after) ? (n.after as string[]) : [n.after as string]
    if (n.expect !== undefined && n.expect !== 'exit 0') {
      throw new Error(`node "${id}": unsupported expect "${n.expect}" (only "exit 0" is supported)`)
    }
    return {
      id,
      role: n.role as NodeDef['role'],
      agent: n.agent as string | undefined,
      after,
      of: n.of as string | undefined,
      panel: n.panel as NodeDef['panel'],
      rounds: n.rounds as number | undefined,
      generates: n.generates as NodeDef['generates'],
      prompt: n.prompt as string | undefined,
      run: n.run as string | undefined,
      expect: n.expect as string | undefined,
      rubric: n.rubric as string | undefined,
      threshold: n.threshold as number | undefined,
      weight: n.weight as number | undefined,
      timeoutMs: n.timeout_ms as number | undefined,
    }
  })
}

function parseRailsPartial(rawRails: Record<string, number> | undefined): Partial<Rails> {
  if (!rawRails) return {}
  return {
    ...(rawRails.max_iterations !== undefined ? { maxIterations: rawRails.max_iterations } : {}),
    ...(rawRails.max_cost_usd !== undefined ? { maxCostUsd: rawRails.max_cost_usd } : {}),
    ...(rawRails.max_wall_minutes !== undefined ? { maxWallMinutes: rawRails.max_wall_minutes } : {}),
    ...(rawRails.stall_after !== undefined ? { stallAfter: rawRails.stall_after } : {}),
    ...(rawRails.replan_limit !== undefined ? { replanLimit: rawRails.replan_limit } : {}),
    ...(rawRails.gate_timeout !== undefined ? { gateTimeoutSec: rawRails.gate_timeout } : {}),
  }
}

export interface GraphFragment {
  nodes: NodeDef[]
  agents?: Record<string, AgentDef>
  rails?: Partial<Rails>
}

// A planner's raw reply routinely arrives wrapped in a markdown code fence
// or a leading sentence ("...I'll output it as clean YAML:\n\n```yaml") even
// when told not to - that instruction is a prompt, not a guarantee. Neither
// wrapping changes the actual graph content, so stripping them is a purely
// mechanical fix-up, not a judgment call - it must never cost an extra LLM
// round the way asking the planner to redo its whole reply would.
function extractYamlCandidate(text: string): string {
  const trimmed = text.trim()
  const fenced = /```(?:ya?ml)?\s*\n([\s\S]*?)```/i.exec(trimmed)
  let candidate = fenced ? fenced[1] : trimmed
  const lines = candidate.split('\n')
  const startIdx = lines.findIndex((l) => /^(graph|agents|rails):/.test(l.trim()))
  if (startIdx > 0) candidate = lines.slice(startIdx).join('\n')
  return candidate.trim()
}

function parseGraphFragmentStrict(text: string): GraphFragment {
  let raw: Record<string, unknown>
  try {
    raw = parse(text) as Record<string, unknown>
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new Error(`invalid graph fragment:\n${msg}`)
  }
  if (!raw || typeof raw !== 'object' || raw.graph === undefined) {
    throw new Error('invalid graph fragment:\ngraph is required')
  }
  if (typeof raw.graph !== 'object' || Array.isArray(raw.graph)) {
    throw new Error('invalid graph fragment:\ngraph must be a map of node id to node definition')
  }
  const nodes = parseGraphNodes(raw.graph as Record<string, Record<string, unknown>>)
  const agents = raw.agents as Record<string, AgentDef> | undefined
  const rails = parseRailsPartial(raw.rails as Record<string, number> | undefined)
  return {
    nodes,
    ...(agents !== undefined ? { agents } : {}),
    ...(Object.keys(rails).length > 0 ? { rails } : {}),
  }
}

// Parses a planner's own output when its node has `generates: 'graph'` (see
// docs/superpowers/specs/2026-07-04-self-planning-loop-design.md) - a
// smaller, looser sibling of parseLoopfile: only `graph:` is required,
// `agents:`/`rails:` are optional, and there is no `name:`/`goal:` at all
// (the fragment inherits the bootstrap loopfile's goal). Reuses
// parseGraphNodes so node-shape rules never drift between the two parsers.
// Tries the text as-is first; only if that fails does it retry against a
// fence/prose-stripped candidate, so well-formed replies never pay for the
// extraction step's own extra parse attempt.
export function parseGraphFragment(text: string): GraphFragment {
  try {
    return parseGraphFragmentStrict(text)
  } catch (err) {
    const candidate = extractYamlCandidate(text)
    if (candidate === text.trim()) throw err
    return parseGraphFragmentStrict(candidate)
  }
}
