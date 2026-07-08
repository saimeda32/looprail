import { execa } from 'execa'
import type {
  Adapter, AgentDef, GateHandler, LoopDef, NodeDef, NodeOutcome, PermissionAnswerer,
} from '../core/types.js'
import { DEFAULT_VERDICT_THRESHOLD, normalizeGateAnswer } from '../core/types.js'
import { composeContext, type RunState } from '../core/context.js'
import { parseVerdict } from '../core/verdict.js'
import type { AdapterRegistry } from '../adapters/registry.js'
import { InfraError, invokeWithRetry, RateLimitError } from './retry.js'

export interface EngineDeps {
  registry: AdapterRegistry
  gate?: GateHandler
  cwd?: string
  cache?: Map<string, NodeOutcome>
  hash?: (nodeId: string, prompt: string) => string
  // Ground truth for blind critics (NodeDef.blind): returns the actual
  // workspace diff since run start. Wired by runner.ts to core/git.ts's
  // workspaceDiff against the run-start HEAD; tests inject a fixed string.
  workspaceDiff?: () => string
  sleep?: (ms: number) => Promise<void>  // retry backoff clock (tests inject instant)
  retries?: number                       // adapter retry budget (default 2)
  // Clamps a node's timeout to the remaining wall-clock budget when a wall rail
  // is set (see runner.ts). Absent when there is no wall rail - behavior is then
  // identical to using node.timeoutMs directly.
  effectiveTimeout?: (nodeTimeoutMs?: number) => number | undefined
  // Brackets a gate's real wall-clock wait for a human answer (see
  // runner.ts, wired to RailsGuard.beginGateWait/endGateWait) so that wait
  // is excluded from max_wall_minutes - a human deciding slowly isn't the
  // loop "taking too long to do work".
  onGateWaitStart?: () => void
  onGateWaitEnd?: () => void
}

const VERIFYING = new Set(['critic', 'judge'])

// Infrastructure-shaped tester failures: the command could not RUN, as
// opposed to the tests running and some asserting false. Conservative on
// purpose - only signatures that unambiguously mean "broken invocation"
// (a real assertion failure whose diff happens to contain one of these
// words as ordinary text must not be misclassified). Matched against the
// tester's combined stdout+stderr.
const TESTER_INFRA_SIGNATURES = [
  /\bcommand not found\b/i,
  /\bis not recognized as (?:an internal|the name)/i, // Windows shell
  /\bCannot find module\b/,
  /\bMODULE_NOT_FOUND\b/,
  /\bERR_MODULE_NOT_FOUND\b/,
  /\bNo test specified\b/i,
  /\bMissing script\b/i,                              // npm: no such script
  /\bENOENT\b/,
  /\bno such file or directory\b/i,
]

export function isTesterInfraFailure(output: string): boolean {
  return TESTER_INFRA_SIGNATURES.some((re) => re.test(output))
}

export async function executeNode(
  def: LoopDef,
  node: NodeDef,
  state: RunState,
  outcomes: Map<string, NodeOutcome>,
  deps: EngineDeps,
  onChunk?: (text: string) => void,
  onPermission?: PermissionAnswerer,
): Promise<NodeOutcome> {
  const base = { nodeId: node.id, role: node.role, costUsd: 0, tokens: 0, durationMs: 0 }
  // A node with no explicit timeout still gets one when a wall rail is set, so a
  // hung subprocess degrades into the timeout/infra path instead of hanging the
  // whole run past the wall deadline. No wall rail => unchanged (node.timeoutMs).
  const timeoutMs = deps.effectiveTimeout ? deps.effectiveTimeout(node.timeoutMs) : node.timeoutMs

  if (node.role === 'tester') {
    try {
      const started = Date.now()
      const res = await execa(node.run!, {
        shell: true, cwd: deps.cwd, reject: false, timeout: timeoutMs,
        all: true,
      })
      const passed = res.exitCode === 0
      const all = res.all ?? ''
      // A non-zero exit does not always mean "the work is wrong" - it can
      // mean "the test COMMAND itself is broken" (a missing script, a
      // command-not-found, a module-resolution failure). Real halt caught
      // live during benchmarking: a package.json `test: "node --test test/"`
      // failed with "Cannot find module .../test" on every iteration - the
      // engine read that as a failing app, fed it to the critic, and the
      // loop ground on the phantom until it hit the wall (~$11.50 wasted).
      // The app was correct; only the invocation was broken. An
      // infrastructure-shaped failure is a config: halt (loud, router.ts
      // stops on it) - never feedback for a critic to iterate against.
      // A genuine assertion failure (tests ran, some failed) stays a fail.
      if (!passed && isTesterInfraFailure(all)) {
        return {
          ...base,
          output: all,
          durationMs: Date.now() - started,
          verdict: {
            node: node.id,
            status: 'error',
            evidence: `config: tester command "${node.run}" failed to run (not a test failure) - ${all.slice(-300).trim() || `exit ${res.exitCode}`}`,
          },
        }
      }
      return {
        ...base,
        output: all,
        durationMs: Date.now() - started,
        verdict: {
          node: node.id,
          status: passed ? 'pass' : 'fail',
          evidence: passed ? `exit 0` : all.slice(-500) || `exit ${res.exitCode}`,
        },
      }
    } catch (err) {
      // execa itself throwing (not a non-zero exit, which is handled above)
      // means the command/shell setup is broken - structural, not transient.
      const msg = err instanceof Error ? err.message : String(err)
      return {
        ...base,
        output: '',
        verdict: { node: node.id, status: 'error', evidence: `config: ${msg}` },
      }
    }
  }

  if (node.role === 'gate') {
    try {
      if (!deps.gate) {
        return { ...base, output: '', verdict: { node: node.id, status: 'error', evidence: 'config: no gate handler configured' } }
      }
      const context = composeContext(def, node, state, outcomes)
      deps.onGateWaitStart?.()
      let answer
      try {
        answer = normalizeGateAnswer(await deps.gate(node, context))
      } finally {
        deps.onGateWaitEnd?.()
      }
      return {
        ...base,
        output: answer.approved ? 'approved' : (answer.feedback ?? 'rejected'),
        verdict: {
          node: node.id,
          status: answer.approved ? 'pass' : 'fail',
          evidence: answer.approved ? 'human approved' : (answer.feedback ? `human feedback: ${answer.feedback}` : 'human rejected'),
        },
      }
    } catch (err) {
      // a gate handler that throws is usually a wiring bug (no handler,
      // handler misconfigured) and gets a config: verdict - but a gate that
      // times out waiting for a human (makeGate's setTimeout race) throws a
      // parked:-tagged error, since a human not answering in time is a
      // human being busy, not a failure of any kind (see router.ts's parked
      // branch). Preserve any existing parked:/infra:/config: prefix instead
      // of blindly re-labeling it, or the router's matching branch never
      // sees it.
      const msg = err instanceof Error ? err.message : String(err)
      const evidence = /^(infra|config|parked):/.test(msg) ? msg : `config: ${msg}`
      return {
        ...base,
        output: '',
        verdict: { node: node.id, status: 'error', evidence },
      }
    }
  }

  if (VERIFYING.has(node.role) && node.of && !outcomes.has(node.of)) {
    return {
      ...base,
      output: '',
      verdict: {
        node: node.id,
        status: 'error',
        evidence: `config: target output for "${node.of}" unavailable - check graph ordering`,
      },
    }
  }

  // resolving the agent/adapter/prompt for this node is structural: an
  // unknown agent key or an unregistered adapter reproduces identically on
  // every iteration and must halt loudly rather than iterate (see the
  // invokeWithRetry call below, whose failures ARE transient).
  let agentKey = node.agent!
  let agentDef: AgentDef, adapter: Adapter, prompt: string, key: string | undefined
  try {
    agentDef = def.agents[agentKey]
    if (!agentDef) throw new Error(`unknown agent "${node.agent}" - check the loop's agents map`)
    adapter = deps.registry.get(agentDef.adapter)
    // A blind critic reviews the actual diff, not the target's narrative -
    // computed fresh here so the prompt (and therefore the cache hash)
    // reflects the workspace as it stands THIS iteration.
    const blindDiff = node.blind && node.of ? deps.workspaceDiff?.() : undefined
    prompt = composeContext(def, node, state, outcomes, blindDiff)
    key = deps.hash?.(node.id, prompt)
    if (key && deps.cache?.has(key)) {
      return { ...deps.cache.get(key)!, costUsd: 0, estimatedCostUsd: undefined, contextHash: key }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return {
      ...base,
      output: '',
      verdict: { node: node.id, status: 'error', evidence: `config: ${msg}` },
    }
  }

  // Rate-limit failover walks the AgentDef.fallback chain, so this whole
  // invocation block loops: each pass runs one agent, and only a spent
  // RateLimitError (see invokeWithRetry) with a usable fallback re-enters it
  // with the next agent's def. `attempted` cycle-guards at runtime
  // independently of validateGraph's config-time check, because a spliced-in
  // agents fragment can rewrite the agents map mid-run without ever passing
  // through that validation.
  const attempted = new Set<string>([agentKey])
  for (;;) {
    try {
      let res = await invokeWithRetry(adapter, {
        prompt, timeoutMs,
        model: agentDef.model, command: agentDef.command, permissions: agentDef.permissions, env: agentDef.env,
      }, deps, onChunk, onPermission)
      let verdict = VERIFYING.has(node.role) ? parseVerdict(node.id, res.output) : null
      let cost = res.costUsd
      let tokens = res.tokens
      let estimatedCost = res.estimatedCostUsd

      if (VERIFYING.has(node.role) && !verdict) {
        const retry = await invokeWithRetry(adapter, {
          prompt: `${prompt}\n\nYour previous reply had no verdict block. Reply again ending with:\nVERDICT: pass|fail\nEVIDENCE: <reason>`,
          timeoutMs,
          model: agentDef.model, command: agentDef.command, permissions: agentDef.permissions, env: agentDef.env,
        }, deps, onChunk, onPermission)
        cost += retry.costUsd
        tokens += retry.tokens
        // estimatedCostUsd is optional (undefined means "no estimate
        // computable", never 0 - see AgentResult) - undefined stays undefined
        // only when NEITHER call produced one; either producing one sums in
        // the other as 0 rather than losing it.
        estimatedCost = (estimatedCost === undefined && retry.estimatedCostUsd === undefined)
          ? undefined
          : (estimatedCost ?? 0) + (retry.estimatedCostUsd ?? 0)
        verdict = parseVerdict(node.id, retry.output)
          ?? { node: node.id, status: 'fail', evidence: 'verdict unparseable' }
        res = retry
      }

      if (VERIFYING.has(node.role) && verdict && verdict.status === 'pass') {
        // Every critic/judge is held to an effective threshold: the loopfile's
        // explicit `threshold:` when set, else DEFAULT_VERDICT_THRESHOLD.
        const effectiveThreshold = node.threshold ?? DEFAULT_VERDICT_THRESHOLD
        if (verdict.score === undefined || !Number.isFinite(verdict.score)) {
          // No usable SCORE to compare: only an explicit threshold fails the
          // verdict here (preserves prior judge behavior). A merely-default
          // threshold must not fail every score-less reply, since most
          // existing critic replies never include a SCORE at all.
          if (node.threshold !== undefined) {
            verdict = { ...verdict, status: 'fail', evidence: `${node.role} reported no usable SCORE; threshold ${node.threshold} requires one` }
          }
        } else if (verdict.score < effectiveThreshold) {
          verdict = { ...verdict, status: 'fail', evidence: `score ${verdict.score} below threshold ${effectiveThreshold}` }
        }
      }

      return {
        ...base, output: res.output, verdict, costUsd: cost, tokens, estimatedCostUsd: estimatedCost,
        durationMs: res.durationMs, contextHash: key,
        // prefer the adapter's own resolved model (e.g. copilot's
        // session.tools_updated data.model) over the loopfile's configured
        // one, which can be "auto" or omitted entirely - see AgentResult.
        // agentKey (not node.agent) so a failed-over call is attributed to
        // the agent that ACTUALLY served it - billing/journal truth, not
        // the loopfile's original intent.
        agent: agentKey, adapter: agentDef.adapter, model: res.resolvedModel ?? agentDef.model,
      }
    } catch (err) {
      if (err instanceof RateLimitError && agentDef.fallback !== undefined
          && !attempted.has(agentDef.fallback) && def.agents[agentDef.fallback]) {
        const nextKey = agentDef.fallback
        const nextDef = def.agents[nextKey]
        let nextAdapter: Adapter | undefined
        try {
          nextAdapter = deps.registry.get(nextDef.adapter)
        } catch {
          // An unregistered fallback adapter can't serve the hop; fall
          // through to the normal failure outcome below rather than trade a
          // rate-limit error for a confusing registry one.
        }
        if (nextAdapter) {
          onChunk?.(`rate-limited on ${agentDef.adapter}; failing over to ${nextKey} (${nextDef.adapter})\n`)
          attempted.add(nextKey)
          agentKey = nextKey
          agentDef = nextDef
          adapter = nextAdapter
          continue
        }
      }
      const msg = err instanceof Error ? err.message : String(err)
      return {
        ...base,
        output: '',
        verdict: {
          node: node.id,
          status: 'error',
          evidence: err instanceof InfraError ? `infra: ${msg}` : msg,
        },
        // agent/adapter were already resolved above (this catch is only
        // reachable once invokeWithRetry itself throws) - kept even on a
        // failed invocation, since agent/adapter is a fact about which agent
        // was attempted last, not about whether it succeeded.
        agent: agentKey, adapter: agentDef.adapter, model: agentDef.model,
      }
    }
  }
}
