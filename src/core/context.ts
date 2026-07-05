import type { LoopDef, NodeDef, NodeOutcome, Role } from './types.js'
import { DEFAULT_VERDICT_THRESHOLD } from './types.js'

export interface RunState {
  plan: string | null
  iteration: number
  feedback: string | null
  // A human's own note, submitted from the dashboard while the run is live
  // (see journal/human-feedback.ts). Distinct from `feedback` (the critic's
  // evidence) so the executor can tell the two apart in its prompt, and
  // one-shot: it applies to the single iteration right after it's read,
  // not carried forward silently.
  humanFeedback?: string | null
}

const VERDICT_FORMAT = [
  'End your reply with exactly this block:',
  'VERDICT: pass|fail',
  'SCORE: <0..1, judges only>',
  'EVIDENCE: <one line citing the concrete reason>',
].join('\n')

const ROLE_INSTRUCTIONS: Record<Role, string> = {
  planner:
    'You are the PLANNER. Decompose the goal into a concrete plan. ' +
    'Every task must have testable success criteria. Output only the plan.',
  critic:
    'You are a CRITIC. Adversarially attack the work below. ' +
    'Try to refute it; report only real, concrete flaws.',
  executor:
    'You are the EXECUTOR. Do the work described by the goal and plan. ' +
    'Address every item in the feedback if any is given.',
  tester:
    'You are the TESTER. Run the configured checks against the work.',
  judge:
    'You are the JUDGE. Score the work against the rubric from 0 to 1. ' +
    'Also verify the work still serves the stated goal (drift check).',
  gate:
    'A human reviewer must approve or reject the work above before the loop can finish.',
  synthesizer:
    'You are the SYNTHESIZER. Merge the branch outputs below into one ' +
    'coherent result, resolving conflicts and removing duplicates.',
}

// A generates:'graph' planner's output is parsed as YAML, and a replan
// gives it its own previous attempt in context ("# Current plan" below) -
// but neither of those things is obvious from a plain "propose a graph"
// prompt, and expecting every loopfile author to spell out "reply with
// ONLY YAML" and "make a targeted edit, don't rewrite from scratch" in
// their own prompt text puts real prompt-engineering expertise on users
// this feature is supposed to spare that burden for. Both instructions are
// unconditional, mechanical requirements of the *feature itself* - they
// belong here as default tool behavior, not as something an example's
// prompt happens to remember to ask for.
const GENERATES_GRAPH_FORMAT_INSTRUCTIONS =
  'Your entire reply must be ONLY a parseable YAML document with a top-level ' +
  'graph key (and agents/rails keys if you need to add any) - no prose, no ' +
  'markdown headers, no explanation before or after it. It will be parsed as ' +
  'YAML directly; anything else will be rejected automatically.'

// An LLM completion can only ever emit one complete reply, never a true
// partial diff - so a prior version of this instruction only asked for
// CONTENT restraint ("keep every unrelated node unchanged"), which never
// reduced the actual OUTPUT TOKEN cost of a retry: the model still had to
// re-emit its whole ~20KB graph from byte zero to honor it. This
// instruction now offers a genuinely cheaper reply shape for a targeted
// fix - a compact top-level `edits:` list the engine applies server-side
// to its own last-known-good copy of the graph (see
// src/config/loopfile.ts's parseGraphEditsFragment/applyGraphEdits for the
// exact shape, validation, and the design note on why this was chosen
// over generic auto-repair or a text-diff format) - while explicitly
// keeping the full `graph:` reply as an always-valid fallback, so a model
// that can't or won't use the compact shape loses nothing versus before.
const GENERATES_GRAPH_EDIT_INSTRUCTIONS =
  'If feedback below is about a specific part of your previous graph (shown ' +
  'above as the current plan), prefer replying with ONLY a compact top-level ' +
  '`edits:` list instead of the full graph - each entry is either ' +
  '`{ node: <id>, set: { <real NodeDef fields to change or add, e.g. prompt, ' +
  'agent, role, after, run, expect> } }` to change an existing node or add a ' +
  'new one (a new node needs at least `role` in `set`), or `{ node: <id>, ' +
  'remove: true }` to delete one. Only real NodeDef field names are valid in ' +
  '`set` - never invented ones. If the fix genuinely cannot be expressed that ' +
  'way, reply with the full graph instead, keeping every node and detail that ' +
  'was not flagged byte-for-byte unchanged - never regenerate the whole graph ' +
  'from scratch when only one part needs to change.'

export function composeContext(
  def: LoopDef,
  node: NodeDef,
  state: RunState,
  outcomes: Map<string, NodeOutcome>,
): string {
  const parts: string[] = [`# Goal\n${def.goal}`]
  if (state.plan) parts.push(`# Current plan\n${state.plan}`)
  if (state.feedback) parts.push(`# Feedback from last iteration\n${state.feedback}`)
  if (state.humanFeedback) parts.push(`# Feedback from a human reviewer\n${state.humanFeedback}`)

  if (node.of) {
    const target = outcomes.get(node.of)
    if (target) parts.push(`# Work under review (from "${node.of}")\n${target.output}`)
  }
  if (node.role === 'judge' || node.role === 'synthesizer' || node.role === 'gate') {
    for (const dep of node.after ?? []) {
      const o = outcomes.get(dep)
      if (o) parts.push(`# Output of "${dep}"\n${o.output}`)
    }
  }
  if (node.rubric) parts.push(`# Rubric\n${node.rubric}`)
  if (node.role === 'critic' || node.role === 'judge') {
    const effectiveThreshold = node.threshold ?? DEFAULT_VERDICT_THRESHOLD
    parts.push(`Pass threshold: SCORE must be >= ${effectiveThreshold}.`)
  }

  parts.push(`# Your role\n${ROLE_INSTRUCTIONS[node.role]}`)
  if (node.generates === 'graph') {
    parts.push(GENERATES_GRAPH_FORMAT_INSTRUCTIONS)
    if (state.plan && state.feedback) parts.push(GENERATES_GRAPH_EDIT_INSTRUCTIONS)
  }
  if (node.prompt) parts.push(`# Additional instructions\n${node.prompt}`)
  if (node.role === 'critic' || node.role === 'judge') parts.push(VERDICT_FORMAT)
  return parts.join('\n\n')
}
