import type { LoopDef, NodeDef, NodeOutcome, Role } from './types.js'
import { DEFAULT_VERDICT_THRESHOLD } from './types.js'
import { descendantsByNode } from './graph.js'

export interface RunState {
  plan: string | null
  iteration: number
  feedback: string | null
  // Structured, per-source feedback for LINEAGE-SCOPED injection. When
  // present, an execution-region node receives only the failing-verdict
  // evidence whose source node is itself or one of its descendants (see
  // core/graph.ts's descendantsByNode) - NOT the whole run's feedback. This
  // is what stops the loop re-running independent branches: a node whose
  // lineage had no failure sees no feedback, so its composed prompt is
  // byte-identical to the prior iteration and the cache serves it instead
  // of pointlessly rebuilding it. The planner still gets the flat global
  // `feedback` (it must see the whole picture to replan). Null on the
  // planning/format/human/splice paths, which keep the flat behavior.
  feedbackBySource?: Array<{ nodeId: string; evidence: string }> | null
  // Last output each node produced, by node id - fed back to a RE-RUNNING
  // executor/synthesizer as "your previous attempt" so it makes the minimal
  // change to address the feedback instead of rebuilding the whole artifact
  // from the goal. Caught live: a benchmark executor re-emitted ~741 lines
  // every iteration to fix one failing test. Only injected when the node
  // also has scoped feedback (i.e. it is actually re-running), so a
  // cache-served node's prompt stays byte-identical and it is not disturbed.
  priorOutputs?: Record<string, string> | null
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
// Real halt caught live: a model with a strong prior toward the common
// generic-graph-library shape ({nodes: [...], edges: [...]}, as networkx/
// d3/vis.js/most "graph" APIs represent one) kept producing exactly that
// instead of looprail's own shape, exhausting its replan budget and halting
// without ever reaching review's actual judgment. A prose-only positive
// description ("a top-level graph key") was not a strong enough signal to
// override that prior - a concrete example of the REAL shape, plus an
// explicit callout of the SPECIFIC wrong shape being ruled out, is.
// Real halt caught live, a second time: a planner referenced `agent: worker`
// on every one of its 3 attempts (initial plan, a compact edit, and a full
// replan) but never once declared a `worker` agent - burning both replans on
// a critic PASS and a genuine content fail, then halting on the exact same
// structural error all 3 times. Root cause was this instruction's OWN
// example: it used `agent: worker` without ever showing an `agents:` block
// that declares it, so the model had nothing but an incomplete template to
// copy from. Fixed by making the example self-contained (it now declares
// every agent it references) and by calling out the failure mode explicitly,
// the same technique that worked for the nodes/edges shape above.
const GENERATES_GRAPH_FORMAT_INSTRUCTIONS =
  'Your entire reply must be ONLY a parseable YAML document with a top-level ' +
  'graph key (and agents/rails keys if you need to add any) - no prose, no ' +
  'markdown headers, no explanation before or after it. It will be parsed as ' +
  'YAML directly; anything else will be rejected automatically.\n\n' +
  'graph is a MAP keyed by node id, each value an object with real NodeDef ' +
  'fields (role, agent, prompt/run/expect, after, etc.) - for example:\n' +
  'agents:\n' +
  '  worker: { adapter: copilot-cli, model: claude-sonnet-5 }\n' +
  'graph:\n' +
  '  build: { role: executor, agent: worker }\n' +
  '  test:  { role: tester, after: build, run: "npm test", expect: "exit 0" }\n\n' +
  'Every `agent:` value must resolve to a real agent - either one already ' +
  'declared to you elsewhere in this conversation, or one you declare ' +
  'yourself in this reply\'s own top-level `agents:` map (as `worker` is ' +
  'above). An agent name that appears in `agent:` but is never declared ' +
  'anywhere is invalid and will be rejected - never reference a name without ' +
  'also declaring it in the same reply.\n\n' +
  'It is NOT a generic graph-library shape - do not reply with a top-level ' +
  '`nodes:` list and a separate `edges:` list (the common networkx/d3-style ' +
  'representation). There is no `nodes:` or `edges:` key anywhere in this ' +
  'format; every node is its own key directly under graph.'

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

// Builds the feedback string a specific node should see: only entries whose
// source is this node or one of its descendants (see the RunState.
// feedbackBySource comment). Returns null when nothing in this node's
// lineage failed - the caller then adds no feedback section at all, which
// is precisely what keeps the node's prompt (and its cache key) stable.
function scopeFeedback(
  def: LoopDef,
  node: NodeDef,
  bySource: Array<{ nodeId: string; evidence: string }>,
): string | null {
  const relevant = new Set<string>([node.id, ...(descendantsByNode(def.nodes).get(node.id) ?? [])])
  const entries = bySource.filter((f) => relevant.has(f.nodeId))
  if (entries.length === 0) return null
  return entries.map((f) => `[${f.nodeId}] ${f.evidence}`).join('\n')
}

export function composeContext(
  def: LoopDef,
  node: NodeDef,
  state: RunState,
  outcomes: Map<string, NodeOutcome>,
  // The actual workspace diff for a blind critic (see NodeDef.blind) -
  // computed by the engine (engine/nodes.ts via EngineDeps.workspaceDiff)
  // because this module is sync and does no IO.
  blindDiff?: string,
): string {
  const parts: string[] = [`# Goal\n${def.goal}`]
  if (state.plan) parts.push(`# Current plan\n${state.plan}`)
  // Lineage-scoped feedback: a non-planner node sees only failures from its
  // own descendants (or itself), so an independent branch that had no
  // failure gets NO feedback section - its prompt stays byte-identical to
  // the prior iteration and the cache serves it instead of re-running it.
  // The planner still gets the flat global feedback (it replans the whole
  // graph and must see every failure). The flat `feedback` is also the
  // fallback whenever structured feedback isn't populated (planning, format,
  // human, splice paths), so those are unchanged.
  const scopedFeedback = node.role !== 'planner' && state.feedbackBySource
    ? scopeFeedback(def, node, state.feedbackBySource)
    : state.feedback
  if (scopedFeedback) parts.push(`# Feedback from last iteration\n${scopedFeedback}`)
  // Incremental memory: a RE-RUNNING executor/synthesizer gets its own
  // previous attempt as the base, so it patches the specific problem
  // instead of regenerating the whole artifact from the goal. Gated on the
  // node actually re-running (it has scoped feedback) so a cache-served
  // node's prompt stays byte-identical - the prior-attempt section never
  // appears on a node that didn't fail. Only work-PRODUCING roles: a critic
  // or judge reviews the current work fresh; it has no attempt to revise.
  if (scopedFeedback && (node.role === 'executor' || node.role === 'synthesizer')) {
    const prior = state.priorOutputs?.[node.id]
    if (prior) {
      parts.push(
        `# Your previous attempt\nRevise this - make the minimal change that addresses the feedback above. Do not rebuild from scratch.\n\n${prior}`,
      )
    }
  }
  if (state.humanFeedback) parts.push(`# Feedback from a human reviewer\n${state.humanFeedback}`)

  if (node.of) {
    if (node.blind) {
      // Blind validation: the critic sees what actually changed on disk,
      // never the target's own account of it - "validators can't lie about
      // code they didn't write" cuts both ways: workers can't lie about
      // code the critic reads directly. An empty/unavailable diff is said
      // out loud rather than silently falling back to the narrative, which
      // would quietly turn blind mode off.
      parts.push(blindDiff
        ? `# Work under review (actual workspace diff since run start - blind mode, the worker's own description is deliberately not shown)\n${blindDiff}`
        : `# Work under review (blind mode)\nNo workspace diff is available (no changes since run start, or not a git repository). If work was claimed, treat that claim as unverified.`)
    } else {
      const target = outcomes.get(node.of)
      if (target) parts.push(`# Work under review (from "${node.of}")\n${target.output}`)
    }
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
