import type { PermissionConfig } from '../adapters/permissions.js'

export type Role =
  | 'planner' | 'critic' | 'executor' | 'tester'
  | 'judge' | 'gate' | 'synthesizer'

export type VerdictStatus = 'pass' | 'fail' | 'stall' | 'error'

export interface Verdict {
  node: string
  status: VerdictStatus
  evidence: string
  score?: number
  weight?: number  // stamped from NodeDef.weight by the scheduler (default 1)
}

export type VerdictPolicy =
  | { kind: 'all-pass' }
  | { kind: 'quorum'; atLeast: number }
  | { kind: 'weighted'; threshold: number }  // pass-weight / total-weight >= threshold

export interface AgentRequest {
  prompt: string
  timeoutMs?: number
  model?: string    // AgentDef.model, plumbed per request (model-tiered adapters)
  command?: string  // AgentDef.command, consumed by the shell adapter
  permissions?: PermissionConfig  // AgentDef.permissions, plumbed per request (see adapters/permissions.ts)
  // AgentDef.env, merged over the inherited process environment when the
  // underlying CLI subprocess is spawned. The intended use is routing an
  // agent's model calls through an optimizing/caching PROXY per provider
  // (e.g. { ANTHROPIC_BASE_URL: "http://localhost:8787" }) - so ONE agent
  // can go through a proxy while another goes direct, without a global env
  // change. looprail wraps CLIs rather than calling model APIs itself, so it
  // does not implement caching; it just points the CLI at whatever proxy
  // the user runs (see the README's proxy note).
  env?: Record<string, string>
}

export interface AgentResult {
  output: string
  costUsd: number
  tokens: number
  // Optional, structurally separate from costUsd: a pricing-derived estimate
  // for adapters whose underlying CLI never reports a real dollar cost
  // (copilot, codex, aider). Undefined means no estimate was computable
  // (e.g. unknown model) - never coerced into 0 or merged into costUsd,
  // which keeps meaning "real, adapter-reported cost".
  estimatedCostUsd?: number
  // Optional split of tokens by direction, needed because input and output
  // tokens are billed at different per-token rates. `tokens` remains the
  // total (sum) for every existing caller.
  inputTokens?: number
  outputTokens?: number
  // The model the underlying CLI actually resolved to, when it reports one
  // (e.g. copilot's session.tools_updated data.model). Needed for pricing
  // lookup when AgentRequest.model was omitted or "auto" - config alone
  // gives no usable key in that case. Undefined when the CLI never
  // surfaces a resolved model.
  resolvedModel?: string
  durationMs: number
}

// A mid-node permission prompt an underlying agent CLI has printed to its own
// stdout while it blocks waiting for a human answer on its own stdin (e.g.
// codex's --ask-for-approval on-request, claude-code's acceptEdits prompt).
// `question` is the text worth showing a person; `answer` turns their
// yes/no (+ optional free-text feedback) into the exact stdin bytes that
// unblock that specific CLI's prompt. Defined here (rather than only in
// adapters/cli-adapter.ts, which re-exports it for compatibility) because
// it appears in the Adapter.invoke signature below, and core/types.ts must
// not import back from an adapter module for its own interface shapes.
export interface PermissionRequest {
  question: string
  answer: (approved: boolean, feedback?: string) => string
}

// Handles a live-surfaced PermissionRequest and resolves once a human (or a
// test) has answered it. A bare boolean is a plain approve/deny; the object
// form carries optional free-text feedback alongside a denial.
export type PermissionAnswerer = (
  req: PermissionRequest,
) => Promise<boolean | { approved: boolean; feedback?: string }>

export interface Adapter {
  name: string
  invoke(
    req: AgentRequest,
    onChunk?: (text: string) => void,
    onPermission?: PermissionAnswerer,
  ): Promise<AgentResult>
}

export interface AgentDef {
  adapter: string
  model?: string
  command?: string
  permissions?: PermissionConfig
  // Extra environment variables for this agent's CLI subprocess, merged over
  // the inherited process env (see AgentRequest.env). Primary use: routing a
  // single agent through a per-provider caching/optimizing proxy.
  env?: Record<string, string>
  // Another agents-map key to hand this agent's call to when its invocation
  // exhausts retries on a rate-limit-shaped failure (engine/retry.ts's
  // RateLimitError; the hop itself lives in engine/nodes.ts). A per-account
  // 429/quota ceiling doesn't clear within one retry window, but a
  // different provider's account is untouched by it - so an overnight run
  // survives a throttled provider instead of failing its node. Validated by
  // core/graph.ts's validateGraph: the key must exist and chains must not
  // cycle.
  fallback?: string
}

// App-level default pass-score floor applied to critic/judge verdicts whose
// loopfile node omits an explicit `threshold:`. 0.7 sits above the midpoint of
// the 0..1 SCORE range so a merely-average self-report doesn't sneak through
// as a pass, while staying low enough that a genuinely solid piece of work
// (as opposed to a perfect one) still clears the bar. An explicit per-node
// `threshold:` always overrides this default in either direction.
export const DEFAULT_VERDICT_THRESHOLD = 0.7

export interface NodeDef {
  id: string
  role: Role
  agent?: string            // key into LoopDef.agents (agent-backed roles)
  after?: string[]          // dependency node ids
  of?: string               // critic target node id
  panel?: number | string[] // fan-out: count (same agent) or one per agent key
  // With panel, under the all-pass policy only: clone 1 runs first (the probe
  // leader - with panel:[a,b,c] the first listed agent leads, so put the
  // cheapest reviewer first); if it FAILS, the remaining clones are skipped,
  // since the iteration's aggregate is already determined to be fail. Never
  // skips on the pass path - verified still requires every clone to run and
  // pass. See docs/superpowers/specs/2026-07-07-probe-panels-design.md.
  probe?: boolean
  // Internal - set by expandPanels on probe followers: the leader clone's id.
  // The scheduler checks the leader's verdict at dispatch time.
  probeOf?: string
  // Blind validation (critics with `of:` only): the critic reviews the
  // ACTUAL workspace diff since run start instead of the target node's own
  // output - a worker's narrative about its work is exactly the thing a
  // lying or hallucinating model fabricates, while the diff cannot be
  // faked. Requires a git workspace; degrades to an explicit "no diff
  // available" note, never silently back to the narrative.
  blind?: boolean
  rounds?: number           // planner-critic revision rounds (critics of planner)
  // When set on a planner node, its output is parsed as a loopfile-fragment
  // (a graph: list, optionally its own agents:/rails:) instead of prose, and
  // spliced into the live run once a gate approves it. See
  // docs/superpowers/specs/2026-07-04-self-planning-loop-design.md.
  generates?: 'graph'
  prompt?: string
  run?: string              // tester shell command
  expect?: string           // tester expectation, e.g. "exit 0"
  rubric?: string           // judge rubric file path or inline text
  threshold?: number        // critic/judge pass-score threshold 0..1; overrides
                            // DEFAULT_VERDICT_THRESHOLD when set (see below)
  weight?: number           // verdict weight under the weighted policy (default 1)
  timeoutMs?: number
}

export interface Rails {
  maxIterations: number
  maxCostUsd: number
  maxWallMinutes?: number
  stallAfter?: number
  replanLimit?: number
  gateTimeoutSec?: number   // gate wait budget in seconds (absent = wait forever)
}

export interface LoopDef {
  name: string
  goal: string
  agents: Record<string, AgentDef>
  nodes: NodeDef[]
  rails: Rails
  verdictPolicy: VerdictPolicy
  concurrency?: number
  // Test-tamper guard: workspace globs whose files must return to their
  // run-start state for the loop to verify. Any change fails the iteration
  // with a revert instruction; a second consecutive violation halts. The
  // loopfile keyword `protect: tests` expands to engine/protect.ts's
  // DEFAULT_TEST_GLOBS. See docs/superpowers/specs/
  // 2026-07-07-test-tamper-guard-design.md.
  protect?: string[]
  // Scope rail: an ALLOWLIST of globs the run may touch. Any change to a
  // file OUTSIDE these globs fails the iteration with a revert instruction
  // (silent scope creep is a top practitioner complaint); a second
  // consecutive violation halts. Enforced alongside protect with the same
  // snapshot machinery (engine/protect.ts).
  scope?: string[]
}

export interface NodeOutcome {
  nodeId: string
  role: Role
  output: string
  verdict: Verdict | null
  costUsd: number
  tokens: number
  estimatedCostUsd?: number
  inputTokens?: number
  outputTokens?: number
  durationMs: number
  contextHash?: string
  // The actually-resolved agent/adapter/model for this invocation - set
  // whenever the node resolved a real AgentDef (absent for tester/gate
  // roles, which have no `agent:`). Threaded through onto the node_end
  // journal event by runner.ts's onNode so the dashboard can show agent/
  // model info straight from the journal itself, without needing a LoopDef
  // at all (a persisted or re-read one is still preferred when available -
  // see journal/loopfile-persist.ts - but this survives even the harder
  // case of resolving it from splice history). `model` prefers the
  // adapter's own AgentResult.resolvedModel (the model the underlying CLI
  // actually used) over the loopfile's configured AgentDef.model, since the
  // configured value can be "auto" or omitted entirely.
  agent?: string
  adapter?: string
  model?: string
}

export type RouterDecision =
  | { action: 'verified' }
  | { action: 'iterate'; feedback: string }
  | { action: 'replan'; feedback: string }
  | { action: 'halt'; reason: string }

export interface ReportClaim {
  claim: string
  confidence: number  // 0-100
  reason: string
}

export interface FinalReport {
  summary: string
  claims: ReportClaim[]
  // 'agent': a reporting agent narrated this from the run's own outcomes.
  // 'fallback': no agent was available, or the one that ran couldn't be
  // parsed - a report is still generated mechanically from verdicts alone,
  // so every run gets one either way.
  source: 'agent' | 'fallback'
  // Real git state (see core/git.ts), never the reporting agent's own
  // narration - populated by runner.ts's buildFinalReport, not by
  // parseReport/buildReportPrompt, since this is never something the
  // reporting agent should be asked to produce. Optional only because a
  // report built without a cwd to inspect never gets this field set at
  // all; once runner.ts does compute it, "not a git repo" and "a git repo
  // with nothing touched" are deliberately collapsed into the same empty
  // array rather than left ambiguous against undefined - callers only ever
  // need to branch on "is there anything to show", not on why not.
  filesTouched?: string[]
}

export interface RunReport {
  runId: string
  status: 'verified' | 'halted'
  reason: string
  iterations: number
  replans: number
  costUsd: number
  // Pricing-derived estimated spend (RailsGuard.estimatedSpentUsd), separate
  // from costUsd (real, adapter-reported spend). Never merged into costUsd -
  // see RailsGuard and NodeOutcome.estimatedCostUsd for why the distinction
  // must survive end to end.
  estimatedCostUsd: number
  outcomes: NodeOutcome[]
  report: FinalReport
}

// A gate handler may return a plain boolean (existing behavior, unchanged)
// or a GateAnswer carrying free-text feedback - a non-empty, non-approval
// answer that should drive a replan rather than a flat rejection. See
// normalizeGateAnswer below and docs/superpowers/specs/2026-07-04-self-planning-loop-design.md.
export interface GateAnswer {
  approved: boolean
  feedback?: string
}
export type GateHandler = (node: NodeDef, context: string) => Promise<boolean | GateAnswer>

export function normalizeGateAnswer(result: boolean | GateAnswer): GateAnswer {
  return typeof result === 'boolean' ? { approved: result } : result
}

// The parked: tag routes a gate timeout to router.ts's parked branch (a
// halt presented as "resume to answer", never as an error) - shared by all
// three gate implementations (cli/run-cmd.ts's makeGate and makeUiGate,
// mcp/tools/gate-registry.ts's makeMcpGate) so a timed-out gate parks
// identically no matter how the run was started. Lives here, not in the
// CLI layer, because the MCP layer must not import from cli/.
export function gateParkedMessage(nodeId: string, timeoutSec: number): string {
  return `parked: gate "${nodeId}" got no human answer within ${timeoutSec}s - resume the run to answer it`
}

export interface JournalEvent {
  ts: number
  type: 'run_start' | 'node_start' | 'node_end' | 'node_skipped' | 'node_progress' | 'iteration_end'
        | 'replan' | 'verified' | 'halt'
        // Emitted when the protect rail catches protected files changed
        // during an iteration. data: { iteration, modified, deleted, added }.
        | 'protect_violation'
        // Same shape for the scope rail: files OUTSIDE the scope: allowlist
        // changed. data: { iteration, modified, deleted, added }.
        | 'scope_violation'
        // Emitted when an agent CLI subprocess running inside a node blocks
        // mid-execution waiting for its OWN tool-permission answer (see
        // dashboard/permission-registry.ts) - distinct from a `role: gate`
        // node, which pauses the engine BETWEEN nodes rather than inside
        // one. data: { nodeId: string; question: string }.
        | 'permission_request'
        // Emitted once a human's answer (relayed via the dashboard's
        // /control answer-permission action) has been written back into
        // that exact subprocess's stdin. data: { nodeId: string;
        // question: string; approved: boolean; feedback?: string }.
        | 'permission_resolved'
  data: Record<string, unknown>
}
