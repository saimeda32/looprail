import type { LoopDef, NodeDef } from '../core/types.js'
import { descendantsByNode, validateGraph } from '../core/graph.js'

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
      message: 'no path to a passing verdict - add a tester, judge, gate, or work critic',
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
        message: `judge "${j.id}" uses the same model as an executor - the model is grading its own homework`,
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
        message: `node "${n.id}" has non-positive weight ${n.weight} - weights must be > 0`,
      })
    }
  }

  if (def.concurrency !== undefined
      && !(typeof def.concurrency === 'number' && def.concurrency > 0)) {
    findings.push({
      rule: 'L007', level: 'error',
      message: `concurrency must be a positive number, got ${JSON.stringify(def.concurrency)} - a non-numeric value collapses the worker pool to zero and nothing runs`,
    })
  }

  // A quorum larger than the number of verdicts the graph can produce can never
  // be met. Panels expand into one verdict per clone, so count clones, not nodes.
  if (def.verdictPolicy.kind === 'quorum') {
    const verifierCount = verifying.reduce((sum, n) => {
      if (typeof n.panel === 'number') return sum + n.panel
      if (Array.isArray(n.panel)) return sum + n.panel.length
      return sum + 1
    }, 0)
    if (def.verdictPolicy.atLeast > verifierCount) {
      findings.push({
        rule: 'L008', level: 'error',
        message: `quorum of ${def.verdictPolicy.atLeast} can never be met - the graph has only ${verifierCount} verifying node(s)`,
      })
    }
  }
  // A weighted policy needs no analogous check: its threshold is a ratio bounded
  // to (0, 1] at parse time, and when every verifier passes the ratio reaches
  // 1.0, so a weighted loop with at least one verifier (guaranteed by L001) is
  // always satisfiable.

  for (const n of def.nodes) {
    const agent = n.agent ? def.agents[n.agent] : undefined
    const raw = (agent?.permissions && typeof agent.permissions === 'object') ? agent.permissions.raw : undefined
    if (raw) {
      for (const rawAdapter of Object.keys(raw)) {
        if (rawAdapter !== agent!.adapter) {
          findings.push({
            rule: 'L009', level: 'warn', node: n.id,
            message: `node "${n.id}"'s agent uses adapter "${agent!.adapter}" but has a permissions.raw key for "${rawAdapter}" - it will never apply`,
          })
        }
      }
    }
  }

  // L010: an executor whose work nothing DOWNSTREAM verifies. L001 already
  // catches a loop with no verifier at all, but a loop can have a verifier
  // for one branch and silently leave another executor's output unchecked -
  // it "verifies" while shipping unverified work, the exact failure looprail
  // exists to prevent. A node's work is verified if any of its descendants
  // (transitive after/of dependents) is a tester/judge/gate or a work critic
  // reviewing it. Planning critics don't count - they review the plan, not
  // the built work.
  const descendants = descendantsByNode(def.nodes)
  const byId = new Map(def.nodes.map((n) => [n.id, n]))
  const isVerifier = (n: NodeDef) =>
    ['tester', 'judge', 'gate'].includes(n.role) || (n.role === 'critic' && !isPlanningCritic(n))
  for (const ex of def.nodes.filter((n) => n.role === 'executor')) {
    const verified = [...(descendants.get(ex.id) ?? [])]
      .map((id) => byId.get(id))
      .some((d) => d !== undefined && isVerifier(d))
    if (!verified) {
      findings.push({
        rule: 'L010', level: 'warn', node: ex.id,
        message: `executor "${ex.id}" produces work that nothing downstream verifies - add a tester or critic that depends on it, or its result ships unchecked`,
      })
    }
  }

  // Probe (EFF-5) misconfigurations that silently do nothing: probe only has
  // an effect on a panel node under the all-pass policy (see expandPanels in
  // core/graph.ts). Both are warns, not errors - the loop still runs
  // correctly, just without the savings the author thought they turned on.
  for (const n of def.nodes.filter((x) => x.probe)) {
    if (!n.panel) {
      findings.push({
        rule: 'L011', level: 'warn', node: n.id,
        message: `node "${n.id}" sets probe without a panel - probe only short-circuits panel clones, so it has no effect here`,
      })
    } else if (def.verdictPolicy.kind !== 'all-pass') {
      findings.push({
        rule: 'L012', level: 'warn', node: n.id,
        message: `probe panel "${n.id}" has no effect under the ${def.verdictPolicy.kind} policy - one clone's fail doesn't determine those aggregates, so the panel runs at full width`,
      })
    }
  }

  // L013: blind only changes what a critic-with-of reviews (the workspace
  // diff instead of the target's narrative) - on anything else it silently
  // does nothing, and the author thinks they turned on protection they
  // didn't get.
  for (const n of def.nodes.filter((x) => x.blind)) {
    if (!(n.role === 'critic' && n.of)) {
      findings.push({
        rule: 'L013', level: 'warn', node: n.id,
        message: `node "${n.id}" sets blind but is not a critic with of: - blind swaps a critic's review target to the workspace diff, so it has no effect here`,
      })
    }
  }

  // L014: fresh-context mode only changes an executor/synthesizer's prompt
  // assembly - set anywhere else it silently does nothing.
  for (const n of def.nodes.filter((x) => x.context === 'fresh')) {
    if (n.role !== 'executor' && n.role !== 'synthesizer') {
      findings.push({
        rule: 'L014', level: 'warn', node: n.id,
        message: `node "${n.id}" sets context: fresh but is a ${n.role} - fresh context only applies to executors and synthesizers, so it has no effect here`,
      })
    }
  }

  return findings
}
