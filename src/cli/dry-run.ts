import type { LoopDef, NodeDef } from '../core/types.js'
import { expandPanels, topoLayers } from '../core/graph.js'
import { dim, heading, ok } from './ui.js'

// One node as it will actually run: its resolved adapter/model (so the human
// sees WHICH model each step spends on before any of it happens) or, for a
// tester, the shell command it will execute.
export interface PreviewNode {
  id: string
  role: string
  agent?: string
  adapter?: string
  model?: string
  detail?: string
}

export interface RunPreview {
  goal: string
  // Dependency layers: nodes in the same layer have no ordering between them
  // and run concurrently (subject to the concurrency cap). This is the order
  // the scheduler will actually walk.
  layers: PreviewNode[][]
  rails: { maxIterations: number; maxCostUsd: number; gateTimeoutSec?: number }
  verifierCount: number
}

// Mirrors config/lint.ts's verifier notion: a planning critic reviews the
// plan, not built work, so it isn't counted as a work-verifier here.
function isWorkVerifier(n: NodeDef, plannerIds: Set<string>): boolean {
  if (['tester', 'judge', 'gate'].includes(n.role)) return true
  return n.role === 'critic' && !(n.of !== undefined && plannerIds.has(n.of))
}

export function previewRun(def: LoopDef): RunPreview {
  // Expand panels first so the preview shows the real clone count the engine
  // will schedule, not the single authored node - a panel of 3 spends 3x.
  const expanded = expandPanels(def)
  const layerIds = topoLayers(expanded.nodes)
  const byId = new Map(expanded.nodes.map((n) => [n.id, n]))
  const layers = layerIds.map((ids) =>
    ids.map((id): PreviewNode => {
      const n = byId.get(id)!
      const agent = n.agent ? expanded.agents[n.agent] : undefined
      const detail = n.role === 'tester' && n.run ? `runs: ${n.run}` : undefined
      return {
        id: n.id,
        role: n.role,
        ...(n.agent ? { agent: n.agent } : {}),
        ...(agent ? { adapter: agent.adapter } : {}),
        ...(agent?.model ? { model: agent.model } : {}),
        ...(detail ? { detail } : {}),
      }
    }),
  )
  const plannerIds = new Set(expanded.nodes.filter((n) => n.role === 'planner').map((n) => n.id))
  const verifierCount = expanded.nodes.filter((n) => isWorkVerifier(n, plannerIds)).length
  return {
    goal: def.goal,
    layers,
    rails: {
      maxIterations: def.rails.maxIterations,
      maxCostUsd: def.rails.maxCostUsd,
      ...(def.rails.gateTimeoutSec !== undefined ? { gateTimeoutSec: def.rails.gateTimeoutSec } : {}),
    },
    verifierCount,
  }
}

function nodeText(n: PreviewNode): string {
  const via = n.adapter
    ? `${n.adapter}${n.model ? `/${n.model}` : ''}`
    : n.detail ?? '(no agent)'
  return `${n.id}  ${dim(`[${n.role}]`)}  ${via}`
}

export function renderPreview(p: RunPreview): string[] {
  const lines: string[] = []
  lines.push(heading('looprail run --dry-run  (no agent will be invoked)'))
  lines.push(`  goal: ${p.goal}`)
  lines.push('')
  lines.push(dim('  execution order (steps in a group run concurrently):'))
  p.layers.forEach((layer, i) => {
    const prefix = `  ${i + 1}. `
    // A lone step sits on the number's own line; a concurrent group lists its
    // steps indented under a "(concurrent)" header so the fan-out is obvious.
    if (layer.length === 1) {
      lines.push(prefix + nodeText(layer[0]))
    } else {
      lines.push(`${prefix}${dim('(concurrent)')}`)
      for (const n of layer) lines.push(`       ${nodeText(n)}`)
    }
  })
  lines.push('')
  lines.push(
    `  budget ceiling: max ${p.rails.maxIterations} iterations, $${p.rails.maxCostUsd}` +
    (p.rails.gateTimeoutSec !== undefined ? `, gate waits ${p.rails.gateTimeoutSec}s` : ''),
  )
  lines.push(`  verifiers: ${p.verifierCount} node(s) must pass for the loop to succeed`)
  lines.push(ok('  looks right? drop --dry-run to execute. nothing was spent.'))
  return lines
}
