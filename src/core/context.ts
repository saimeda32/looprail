import type { LoopDef, NodeDef, NodeOutcome } from './types.js'

export interface RunState {
  plan: string | null
  iteration: number
  feedback: string | null
}

const VERDICT_FORMAT = [
  'End your reply with exactly this block:',
  'VERDICT: pass|fail',
  'SCORE: <0..1, judges only>',
  'EVIDENCE: <one line citing the concrete reason>',
].join('\n')

const ROLE_INSTRUCTIONS: Record<string, string> = {
  planner:
    'You are the PLANNER. Decompose the goal into a concrete plan. ' +
    'Every task must have testable success criteria. Output only the plan.',
  critic:
    'You are a CRITIC. Adversarially attack the work below. ' +
    'Try to refute it; report only real, concrete flaws.',
  executor:
    'You are the EXECUTOR. Do the work described by the goal and plan. ' +
    'Address every item in the feedback if any is given.',
  judge:
    'You are the JUDGE. Score the work against the rubric from 0 to 1. ' +
    'Also verify the work still serves the stated goal (drift check).',
  synthesizer:
    'You are the SYNTHESIZER. Merge the branch outputs below into one ' +
    'coherent result, resolving conflicts and removing duplicates.',
}

export function composeContext(
  def: LoopDef,
  node: NodeDef,
  state: RunState,
  outcomes: Map<string, NodeOutcome>,
): string {
  const parts: string[] = [`# Goal\n${def.goal}`]
  if (state.plan) parts.push(`# Current plan\n${state.plan}`)
  if (state.feedback) parts.push(`# Feedback from last iteration\n${state.feedback}`)

  if (node.of) {
    const target = outcomes.get(node.of)
    if (target) parts.push(`# Work under review (from "${node.of}")\n${target.output}`)
  }
  if (node.role === 'judge' || node.role === 'synthesizer') {
    for (const dep of node.after ?? []) {
      const o = outcomes.get(dep)
      if (o) parts.push(`# Output of "${dep}"\n${o.output}`)
    }
  }
  if (node.rubric) parts.push(`# Rubric\n${node.rubric}`)
  if (node.threshold !== undefined) {
    parts.push(`Pass threshold: SCORE must be >= ${node.threshold}.`)
  }

  parts.push(`# Your role\n${ROLE_INSTRUCTIONS[node.role] ?? ''}`)
  if (node.prompt) parts.push(`# Additional instructions\n${node.prompt}`)
  if (node.role === 'critic' || node.role === 'judge') parts.push(VERDICT_FORMAT)
  return parts.join('\n\n')
}
