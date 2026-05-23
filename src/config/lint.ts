import type { LoopDef, NodeDef } from '../core/types.js'
import { validateGraph } from '../core/graph.js'

export interface LintFinding {
  rule: string
  level: 'error' | 'warn'
  message: string
  node?: string
}

export function lintLoop(def: LoopDef): LintFinding[] {
  const findings: LintFinding[] = []

  for (const err of validateGraph(def)) {
    findings.push({ rule: 'L005', level: 'error', message: err })
  }

  const plannerIds = new Set(def.nodes.filter((n) => n.role === 'planner').map((n) => n.id))
  const isPlanningCritic = (n: NodeDef) =>
    n.role === 'critic' && n.of !== undefined && plannerIds.has(n.of)
  const verifying = def.nodes.filter(
    (n) => ['tester', 'judge', 'gate'].includes(n.role) ||
           (n.role === 'critic' && !isPlanningCritic(n)),
  )
  if (verifying.length === 0) {
    findings.push({
      rule: 'L001', level: 'error',
      message: 'no path to a passing verdict — add a tester, judge, gate, or work critic',
    })
  }

  if (!(def.rails.maxIterations > 0) || !(def.rails.maxCostUsd > 0)) {
    findings.push({
      rule: 'L002', level: 'error',
      message: 'rails must set max_iterations and max_cost_usd above zero',
    })
  }

  const agentKey = (name?: string) => {
    const a = name ? def.agents[name] : undefined
    return a ? `${a.adapter}/${a.model ?? ''}` : undefined
  }
  const executorKeys = new Set(
    def.nodes.filter((n) => n.role === 'executor').map((n) => agentKey(n.agent)),
  )
  for (const j of def.nodes.filter((n) => n.role === 'judge')) {
    if (agentKey(j.agent) && executorKeys.has(agentKey(j.agent))) {
      findings.push({
        rule: 'L003', level: 'warn', node: j.id,
        message: `judge "${j.id}" uses the same model as an executor — the model is grading its own homework`,
      })
    }
  }

  for (const p of def.nodes.filter((n) => n.panel)) {
    const hasAggregator = def.nodes.some(
      (n) => (n.role === 'judge' || n.role === 'synthesizer') && n.after?.includes(p.id),
    )
    if (!hasAggregator) {
      findings.push({
        rule: 'L004', level: 'warn', node: p.id,
        message: `panel "${p.id}" has no downstream judge or synthesizer to aggregate its findings`,
      })
    }
  }

  for (const n of def.nodes) {
    if (n.weight !== undefined && !(n.weight > 0)) {
      findings.push({
        rule: 'L006', level: 'error', node: n.id,
        message: `node "${n.id}" has non-positive weight ${n.weight} — weights must be > 0`,
      })
    }
  }

  return findings
}
