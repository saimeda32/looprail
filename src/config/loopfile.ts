import { parse } from 'yaml'
import type { LoopDef, NodeDef, VerdictPolicy } from '../core/types.js'

export function parseLoopfile(text: string): LoopDef {
  const raw = parse(text) as Record<string, unknown>
  const problems: string[] = []
  for (const field of ['name', 'goal', 'agents', 'graph', 'rails']) {
    if (raw?.[field] === undefined) problems.push(`missing required field "${field}"`)
  }
  if (problems.length > 0) throw new Error(`invalid loopfile:\n${problems.join('\n')}`)

  const graph = raw.graph as Record<string, Record<string, unknown>>
  const nodes: NodeDef[] = Object.entries(graph).map(([id, n]) => {
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
      prompt: n.prompt as string | undefined,
      run: n.run as string | undefined,
      expect: n.expect as string | undefined,
      rubric: n.rubric as string | undefined,
      threshold: n.threshold as number | undefined,
      timeoutMs: n.timeout_ms as number | undefined,
    }
  })

  const rawRails = raw.rails as Record<string, number>
  const rawVerdict = (raw.verdict as { policy?: unknown } | undefined)?.policy
  let verdictPolicy: VerdictPolicy = { kind: 'all-pass' }
  if (rawVerdict && typeof rawVerdict === 'object' && 'quorum' in rawVerdict) {
    verdictPolicy = { kind: 'quorum', atLeast: (rawVerdict as { quorum: number }).quorum }
  }

  return {
    name: raw.name as string,
    goal: raw.goal as string,
    agents: raw.agents as LoopDef['agents'],
    nodes,
    rails: {
      maxIterations: rawRails.max_iterations,
      maxCostUsd: rawRails.max_cost_usd,
      ...(rawRails.max_wall_minutes !== undefined ? { maxWallMinutes: rawRails.max_wall_minutes } : {}),
      ...(rawRails.stall_after !== undefined ? { stallAfter: rawRails.stall_after } : {}),
      ...(rawRails.replan_limit !== undefined ? { replanLimit: rawRails.replan_limit } : {}),
    },
    verdictPolicy,
    ...(raw.concurrency !== undefined ? { concurrency: raw.concurrency as number } : {}),
  }
}
