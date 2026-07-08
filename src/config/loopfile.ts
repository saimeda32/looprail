import { parse, stringify } from 'yaml'
import type { AgentDef, LoopDef, NodeDef, Rails, Role, VerdictPolicy } from '../core/types.js'
import { DEFAULT_TEST_GLOBS } from '../engine/protect.js'

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

  // Parsed BEFORE the problems check below so a malformed protect value is a
  // hard parse error - a typo'd protect field must never silently unprotect.
  const protect = parseProtect(raw.protect, problems)
  const scope = parseScope(raw.scope, problems)
  const ledger = parseLedger(raw.ledger, problems)

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
    ...protect,
    ...scope,
    ...ledger,
  }
}

// `protect: tests` is the keyword form (the built-in test-shaped globs);
// an explicit list is taken verbatim. Anything else is a parse problem, not
// a silent no-op - a typo'd protect field must never silently unprotect.
function parseProtect(raw: unknown, problems: string[]): { protect?: string[] } {
  if (raw === undefined) return {}
  if (raw === 'tests') return { protect: [...DEFAULT_TEST_GLOBS] }
  if (Array.isArray(raw) && raw.length > 0 && raw.every((g) => typeof g === 'string')) {
    return { protect: raw as string[] }
  }
  problems.push('protect must be the keyword "tests" or a non-empty list of glob strings')
  return {}
}

// scope: is allowlist globs only - there is no keyword form, because unlike
// "tests" there is no universal answer to "what may this task touch".
function parseScope(raw: unknown, problems: string[]): { scope?: string[] } {
  if (raw === undefined) return {}
  if (Array.isArray(raw) && raw.length > 0 && raw.every((g) => typeof g === 'string')) {
    return { scope: raw as string[] }
  }
  problems.push('scope must be a non-empty list of glob strings (the files the run is allowed to change)')
  return {}
}

// ledger: true -> the conventional in-repo path; a string is a custom path.
function parseLedger(raw: unknown, problems: string[]): { ledger?: string } {
  if (raw === undefined || raw === false) return {}
  if (raw === true) return { ledger: '.looprail/ledger.jsonl' }
  if (typeof raw === 'string' && raw.trim().length > 0) return { ledger: raw }
  problems.push('ledger must be true or a file path string')
  return {}
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
      probe: n.probe as boolean | undefined,
      blind: n.blind as boolean | undefined,
      context: n.context as NodeDef['context'],
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

// Real halt caught live: a generates:'graph' planner (claude-sonnet-5, via
// copilot-cli) replied with `graph: { nodes: [ {id, role, ...}, ... ],
// edges: [...] }` - the common networkx/d3/vis.js graph-library
// convention - instead of looprail's own `graph: { <id>: {role, ...} }`
// map. Every node in the array already carried the correct NodeDef fields
// (role, agent, prompt, after, expect) plus its own `id`; the ONLY thing
// wrong was the wrapping shape. That makes this purely mechanical to
// repair - no judgment call, no invented content - so it is fixed here,
// the same way a fenced/prose-wrapped reply already is by
// extractYamlCandidate, rather than costing a full expensive replan (a
// fresh planner+critic round) for what is really a one-line reshape.
// `edges` entries are folded into the target node's `after` list, trying
// the two common field-name conventions ({from,to} and {source,target})
// plus a bare 2-tuple array.
function normalizeNodesEdgesShape(graph: Record<string, unknown>): Record<string, unknown> {
  if (!Array.isArray(graph.nodes)) return graph
  const byId: Record<string, Record<string, unknown>> = {}
  for (const raw of graph.nodes) {
    if (!raw || typeof raw !== 'object' || typeof (raw as Record<string, unknown>).id !== 'string') continue
    const { id, ...rest } = raw as Record<string, unknown> & { id: string }
    byId[id] = rest
  }
  if (Array.isArray(graph.edges)) {
    for (const edge of graph.edges) {
      let from: unknown, to: unknown
      if (Array.isArray(edge)) [from, to] = edge
      else if (edge && typeof edge === 'object') {
        const e = edge as Record<string, unknown>
        from = e.from ?? e.source
        to = e.to ?? e.target
      }
      if (typeof from !== 'string' || typeof to !== 'string' || !byId[to]) continue
      const existing = byId[to].after
      const after = Array.isArray(existing) ? existing as string[] : existing === undefined ? [] : [existing as string]
      if (!after.includes(from)) after.push(from)
      byId[to].after = after
    }
  }
  return byId
}

// Real halt caught live (same benchmarking session as normalizeNodesEdgesShape
// above): a planner's first attempt wrote prose expect fields ("file server.js
// exists and `node -c server.js` passes...") on its executor nodes. expect
// only supports the literal "exit 0" (see parseGraphNodes), so the whole
// otherwise-sound plan was rejected and a paid replan spent on a purely
// structural problem. The repair is mechanical, not a judgment call:
//  - a node WITH a run command keeps its real check (the command's own exit
//    code) - the prose expect collapses to "exit 0";
//  - a node WITHOUT a run command has nothing executable to check, so the
//    prose is folded into the prompt as success criteria - the intent stays
//    visible to the agent instead of being silently discarded.
// Applied only to planner-generated fragments (this file's fragment path) -
// parseLoopfile is untouched, so a hand-written loopfile's typo still fails
// loudly at the author, exactly as before.
function repairProseExpect(graph: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [id, raw] of Object.entries(graph)) {
    if (!raw || typeof raw !== 'object' || typeof (raw as Record<string, unknown>).expect !== 'string') {
      out[id] = raw
      continue
    }
    const node = { ...(raw as Record<string, unknown>) }
    const expect = (node.expect as string).trim()
    if (expect === 'exit 0') {
      node.expect = 'exit 0' // normalize away stray whitespace padding
    } else if (typeof node.run === 'string' && node.run.trim() !== '') {
      node.expect = 'exit 0'
    } else {
      delete node.expect
      const criteria = `Success criteria (verify before finishing): ${expect}`
      node.prompt = typeof node.prompt === 'string' && node.prompt.trim() !== ''
        ? `${node.prompt}\n\n${criteria}`
        : criteria
    }
    out[id] = node
  }
  return out
}

function parseGraphFragmentStrict(text: string): GraphFragment {
  let raw: Record<string, unknown>
  try {
    raw = parse(text) as Record<string, unknown>
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new Error(`invalid graph fragment:\n${msg}`, { cause: err })
  }
  if (!raw || typeof raw !== 'object' || raw.graph === undefined) {
    throw new Error('invalid graph fragment:\ngraph is required')
  }
  if (typeof raw.graph !== 'object' || Array.isArray(raw.graph)) {
    throw new Error('invalid graph fragment:\ngraph must be a map of node id to node definition')
  }
  const normalizedGraph = repairProseExpect(normalizeNodesEdgesShape(raw.graph as Record<string, unknown>))
  const nodes = parseGraphNodes(normalizedGraph as Record<string, Record<string, unknown>>)
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

// ---------------------------------------------------------------------
// DESIGN NOTE - reducing the output-token cost of a replanned/retried
// generates:'graph' planner (see src/core/context.ts's
// GENERATES_GRAPH_EDIT_INSTRUCTIONS and src/engine/runner.ts's
// runPlanning round loop, which already hold the last-known-good full
// graph in RunState.plan on every replan).
//
// THE PROBLEM: an LLM completion can only ever emit ONE complete reply,
// never a true partial diff - so today, a planner asked to fix one
// flagged gap (a missing agent-key rename, a missing test requirement)
// still pays full-output-token cost for its entire ~20KB graph on every
// retry, even though composeContext already asks it (in prose) to keep
// every unrelated node byte-for-byte unchanged. Prose restraint bounds
// CONTENT drift, not output MEDIUM cost.
//
// THREE ANGLES WERE CONSIDERED:
//
// (a) Extend deterministic auto-repair (the precedent already shipped in
//     parseGraphFragment's fence-stripping and spliceFragment's
//     agent-key/node-id auto-rename) to more failure classes, so the LLM
//     is never asked to redo anything for them.
//     REJECTED AS THE PRIMARY FIX: it only ever applies to failures the
//     ENGINE already fully understands the correct repair for (a
//     colliding id, a stray markdown fence). The actual motivating case -
//     "this node's prompt is missing a test requirement" - is a
//     CONTENT-JUDGMENT change. No deterministic rule can invent the
//     missing sentence a model needs to write; there is no mechanical
//     "correct" edit to auto-apply. (a) is kept exactly as-is (it already
//     covers its own, disjoint failure class) but cannot be the answer to
//     the goal's actual observed cost.
//
// (b) Offer a small, explicit, structured edit instruction - a top-level
//     `edits:` YAML list of { node, set } / { node, remove } - that the
//     ENGINE applies to the last-known-good full fragment server-side,
//     rather than trusting the model to reproduce everything else
//     verbatim.
//     CHOSEN. It directly targets the observed cost (a content-judgment
//     fix expressed as a few changed fields, not a mechanically-derivable
//     one) while keeping the actual graph-merge deterministic and testable
//     (applyGraphEdits below is a pure function over data the engine
//     already trusts, not a re-interpretation of untrusted model prose).
//     The obvious risk - "a malformed patch is exactly as likely as a
//     malformed full document, so we've traded one reliability problem
//     for another" - is answered structurally, not aspirationally: the
//     full `graph:` reply remains an ALWAYS-VALID alternative. An absent
//     `edits:` key falls straight through to the existing full-graph
//     parse path (parseGraphEditsFragment returns null, not a throw, for
//     "this isn't an edits reply at all"). A malformed edits block (bad
//     shape, unknown nodeId, invented non-NodeDef field, or a `set` on an
//     unknown node with no `role` to create it) throws instead, and
//     src/engine/runner.ts's round loop feeds that back through the exact
//     same OUTPUT-FORMAT-ERROR self-correction round a broken full-graph
//     reply already gets today - never a crash, never silently-corrupted
//     state, never a worse outcome than today's baseline.
//
// (c) Ask the model for a generic text-diff format (unified diff,
//     JSON Patch/RFC 6902) against the serialized graph.
//     REJECTED: these formats are built for stable, line-oriented,
//     already-serialized text, and this project's own YAML serialization
//     of a re-parsed structure is not guaranteed byte-stable (key
//     ordering, quoting, flow-vs-block style) across a round trip - a
//     context/line-offset-addressed diff against it is exactly the kind
//     of reliably-unreliable format the goal explicitly warned against.
//     A structured, per-NodeDef-field, per-nodeId `edits:` list has no
//     such addressing problem: "node build-3, set prompt to <this
//     string>" survives any re-serialization untouched, because it never
//     depends on line numbers or byte offsets in the first place.
//
// SCOPE: this first implementation targets the generates:'graph' replan
// path specifically (parseGraphEditsFragment / applyGraphEdits here, plus
// the composeContext instruction and runPlanning integration) - not every
// retried node in the engine. The broader goal (any replanned/retried
// node) is not fully delivered in this pass; scoping down was a deliberate
// choice, not a silent omission. Rationale: `generates:'graph'` is the
// only node type sitting on a KNOWN structured document (a GraphFragment)
// that the engine can validate a proposed edit against; a generic
// executor/critic node's output is unstructured free text, where "apply
// this edit server-side" has no equivalent well-defined target to apply
// to without inventing an entirely separate content-diffing system out of
// scope for one pass. The SAME pattern (retain the last-known-good
// structured artifact; let the model send a small delta against it;
// engine applies and re-validates; fall back to a full reply on anything
// unparseable) generalizes to any OTHER node whose output is likewise a
// parseable structured artifact the engine already round-trips - it just
// has no such artifact to generalize to yet outside generates:'graph'.
// ---------------------------------------------------------------------

// One directive inside a top-level `edits:` reply (see the design note
// above). `set` changes/creates fields on `node`; `remove: true` deletes
// it. Both are optional on the type only so a malformed reply (neither
// present) can be caught with a real error message in applyGraphEdits
// rather than a silent no-op.
export interface GraphEditOp {
  node: string
  set?: Record<string, unknown>
  remove?: boolean
}

export interface GraphEditsFragment {
  edits: GraphEditOp[]
  agents?: Record<string, AgentDef>
  rails?: Partial<Rails>
}

// Every field name a `set` may use - the exact raw loopfile vocabulary a
// planner already uses when writing a full `graph:` node (including
// `timeout_ms`'s snake_case, matching parseGraphNodes' own raw input
// shape), so there is nothing new to learn for this reply shape versus a
// full one. Anything outside this set is an invented, non-NodeDef field
// and must be rejected rather than silently accepted (see the design note
// above on why (a) alone cannot help here, and why reliability can't
// regress versus a full-graph reply).
const VALID_EDIT_SET_KEYS = new Set([
  'role', 'agent', 'after', 'of', 'panel', 'rounds', 'generates',
  'prompt', 'run', 'expect', 'rubric', 'threshold', 'weight', 'timeout_ms',
])

// Inverse of parseGraphNodes' per-node shape: turns an already-parsed
// NodeDef back into the raw record shape a loopfile author/planner would
// have written it as. Used both to seed applyGraphEdits' base (so a `set`
// can be merged onto it and re-validated through parseGraphNodes, the
// exact same path a full-graph reply's nodes go through) and by
// serializeGraphFragment below.
function nodeToRaw(n: NodeDef): Record<string, unknown> {
  const raw: Record<string, unknown> = { role: n.role }
  if (n.agent !== undefined) raw.agent = n.agent
  if (n.after !== undefined) raw.after = n.after
  if (n.of !== undefined) raw.of = n.of
  if (n.panel !== undefined) raw.panel = n.panel
  if (n.rounds !== undefined) raw.rounds = n.rounds
  if (n.generates !== undefined) raw.generates = n.generates
  if (n.prompt !== undefined) raw.prompt = n.prompt
  if (n.run !== undefined) raw.run = n.run
  if (n.expect !== undefined) raw.expect = n.expect
  if (n.rubric !== undefined) raw.rubric = n.rubric
  if (n.threshold !== undefined) raw.threshold = n.threshold
  if (n.weight !== undefined) raw.weight = n.weight
  if (n.timeoutMs !== undefined) raw.timeout_ms = n.timeoutMs
  return raw
}

function railsToRaw(rails: Partial<Rails>): Record<string, number> {
  const raw: Record<string, number> = {}
  if (rails.maxIterations !== undefined) raw.max_iterations = rails.maxIterations
  if (rails.maxCostUsd !== undefined) raw.max_cost_usd = rails.maxCostUsd
  if (rails.maxWallMinutes !== undefined) raw.max_wall_minutes = rails.maxWallMinutes
  if (rails.stallAfter !== undefined) raw.stall_after = rails.stallAfter
  if (rails.replanLimit !== undefined) raw.replan_limit = rails.replanLimit
  if (rails.gateTimeoutSec !== undefined) raw.gate_timeout = rails.gateTimeoutSec
  return raw
}

// Parses a planner's reply as a compact `edits:` block instead of a full
// `graph:` document (see the design note above). Returns null - not a
// throw - when the reply has no top-level `edits:` key at all: that means
// "this isn't an edits reply", and the caller (runner.ts) must fall
// through to the existing full-graph parse path untouched. Once an
// `edits:` key IS present, every other problem (bad shape, an entry
// without a `node` id, mixing `edits:` with a full `graph:` in the same
// reply) throws, so the caller's existing OUTPUT-FORMAT-ERROR
// self-correction round handles it - never a silent partial-corruption.
// Mirrors parseGraphFragment's own fence/prose-stripped retry so a stray
// ```yaml wrapper doesn't cost an extra round here either.
export function parseGraphEditsFragment(text: string): GraphEditsFragment | null {
  const trimmed = text.trim()
  const candidates = [trimmed]
  const extracted = extractYamlCandidate(text)
  if (extracted !== trimmed) candidates.push(extracted)

  for (const candidate of candidates) {
    let raw: unknown
    try {
      raw = parse(candidate)
    } catch {
      continue
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue
    const obj = raw as Record<string, unknown>
    if (obj.edits === undefined) continue // not an edits reply at all

    if (obj.graph !== undefined) {
      throw new Error('invalid edits: a reply cannot contain both "edits" and "graph" - pick one')
    }
    if (!Array.isArray(obj.edits)) {
      throw new Error('invalid edits: "edits" must be a list')
    }
    const edits: GraphEditOp[] = obj.edits.map((entry, i) => {
      if (!entry || typeof entry !== 'object' || typeof (entry as Record<string, unknown>).node !== 'string') {
        throw new Error(`invalid edits: entry ${i} needs a "node" id`)
      }
      const e = entry as Record<string, unknown>
      return {
        node: e.node as string,
        ...(e.set !== undefined ? { set: e.set as Record<string, unknown> } : {}),
        ...(e.remove !== undefined ? { remove: Boolean(e.remove) } : {}),
      }
    })
    const agents = obj.agents as Record<string, AgentDef> | undefined
    const rails = parseRailsPartial(obj.rails as Record<string, number> | undefined)
    return {
      edits,
      ...(agents !== undefined ? { agents } : {}),
      ...(Object.keys(rails).length > 0 ? { rails } : {}),
    }
  }
  return null
}

// Applies a parsed `edits:` block to `base` (the engine's last-known-good
// GraphFragment, held by runner.ts across a replan) and returns a NEW
// fragment - pure, never mutates `base`, so a caller can safely discard
// the result on any downstream validation failure and keep using the same
// `base` for the NEXT attempt. Re-runs every edited/added node through
// parseGraphNodes (the exact same node-shape validation a full `graph:`
// reply's nodes get - unsupported `expect`, `after` normalization, etc.),
// so an edits reply never has a looser bar than a full one would.
export function applyGraphEdits(base: GraphFragment, editsFragment: GraphEditsFragment): GraphFragment {
  const rawGraph: Record<string, Record<string, unknown>> = {}
  const order: string[] = []
  for (const n of base.nodes) {
    rawGraph[n.id] = nodeToRaw(n)
    order.push(n.id)
  }

  for (const op of editsFragment.edits) {
    if (op.remove) {
      if (!(op.node in rawGraph)) {
        throw new Error(`invalid edits: cannot remove unknown node "${op.node}"`)
      }
      delete rawGraph[op.node]
      const idx = order.indexOf(op.node)
      if (idx !== -1) order.splice(idx, 1)
      continue
    }
    if (!op.set || typeof op.set !== 'object') {
      throw new Error(`invalid edits: entry for node "${op.node}" needs a "set" (or "remove: true")`)
    }
    for (const key of Object.keys(op.set)) {
      if (!VALID_EDIT_SET_KEYS.has(key)) {
        throw new Error(`invalid edits: node "${op.node}" sets unknown field "${key}" - not a real NodeDef field`)
      }
    }
    const isNew = !(op.node in rawGraph)
    if (isNew && op.set.role === undefined) {
      throw new Error(`invalid edits: node "${op.node}" does not exist yet and no "role" was set to create it`)
    }
    rawGraph[op.node] = { ...(rawGraph[op.node] ?? {}), ...op.set }
    if (isNew) order.push(op.node)
  }

  const orderedRawGraph: Record<string, Record<string, unknown>> = {}
  for (const id of order) orderedRawGraph[id] = rawGraph[id]!
  const nodes = parseGraphNodes(orderedRawGraph)

  return {
    nodes,
    ...(base.agents || editsFragment.agents ? { agents: { ...base.agents, ...editsFragment.agents } } : {}),
    ...(base.rails || editsFragment.rails ? { rails: { ...base.rails, ...editsFragment.rails } } : {}),
  }
}

// Inverse of parseGraphFragment - turns a GraphFragment back into YAML
// text. Used after applying an edits block so RunState.plan always holds
// a full graph document (never just the compact edits reply): downstream
// consumers - composeContext's "# Current plan" display, a later
// applySplice, and the NEXT edits reply's own base - all depend on
// RunState.plan being a complete, re-parseable document, regardless of
// which reply shape (full graph or compact edits) actually produced it.
export function serializeGraphFragment(fragment: GraphFragment): string {
  const graph: Record<string, unknown> = {}
  for (const n of fragment.nodes) graph[n.id] = nodeToRaw(n)
  const doc: Record<string, unknown> = { graph }
  if (fragment.agents && Object.keys(fragment.agents).length > 0) doc.agents = fragment.agents
  if (fragment.rails && Object.keys(fragment.rails).length > 0) doc.rails = railsToRaw(fragment.rails)
  return stringify(doc)
}
