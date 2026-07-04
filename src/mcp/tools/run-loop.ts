import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import {
  createDefaultRegistry, expandPanels, lintLoop, parseLoopfile, runLoop, validateGraph,
  type RunReport,
} from '../../index.js'
import type { McpToolDeps } from './deps.js'
import { makeMcpGate, sweepPendingGates, type GateTimerDeps } from './gate-registry.js'
import { errorResult, textResult } from './result.js'

export interface RunLoopInput {
  file?: string
  cwd?: string
}

export interface RunLoopOutcome {
  result: CallToolResult
  // Test-only: the exact promise runLoop() returns. Never sent over the
  // real MCP wire - see registerRunLoopTool below, which returns only
  // `.result`. Tests await this to deterministically observe the detached
  // run's eventual outcome with no polling and no real timer.
  done: Promise<RunReport | undefined>
}

export async function runLoopHandler(
  input: RunLoopInput, deps: McpToolDeps, gateTimerDeps: GateTimerDeps = {},
): Promise<RunLoopOutcome> {
  const cwd = input.cwd ?? deps.cwd
  const path = resolve(cwd, input.file ?? 'looprail.yaml')
  if (!existsSync(path)) {
    return {
      result: errorResult(`no loopfile at ${path} - run \`looprail init\` to scaffold one`),
      done: Promise.resolve(undefined),
    }
  }

  let def
  try {
    def = parseLoopfile(readFileSync(path, 'utf8'))
  } catch (e) {
    return {
      result: errorResult(e instanceof Error ? e.message : String(e)),
      done: Promise.resolve(undefined),
    }
  }

  const findings = lintLoop(def)
  const errors = findings.filter((f) => f.level === 'error')
  if (errors.length > 0) {
    return {
      result: errorResult(
        `loop failed lint - not started:\n${errors.map((f) => `${f.rule} ${f.message}`).join('\n')}`),
      done: Promise.resolve(undefined),
    }
  }

  // lintLoop only validates the raw graph (L005), but runLoop validates AGAIN
  // after expandPanels - panel-expansion-specific faults (e.g. a clone id
  // colliding with a literal node id) can slip past the raw check and only
  // surface here. Catch that synchronously too, so an unrunnable-after-
  // expansion loop is rejected before 'started' is ever reported, same as
  // an unrunnable-before-expansion one already is above.
  const expansionErrors = validateGraph(expandPanels(def))
  if (expansionErrors.length > 0) {
    return {
      result: errorResult(`loop is invalid after panel expansion - not started:\n${expansionErrors.join('\n')}`),
      done: Promise.resolve(undefined),
    }
  }

  const runId = `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
  const runDir = join(cwd, '.looprail', 'runs', runId)
  const registry = createDefaultRegistry({ cwd })

  // Detached on purpose (see design decision 1 / decision 7): this promise
  // keeps running for as long as this `looprail mcp` process stays alive - 
  // which is for as long as the host (Claude Desktop / Cursor / VS Code)
  // keeps the stdio connection to it open. Every event lands durably in
  // runDir's journal as it happens, so run_status observes progress with
  // zero shared in-memory state between this call and a later one.
  //
  // gate: a real GateHandler (see gate-registry.ts) so a gate node PAUSES
  // this run - registering a pending entry the new approve_gate tool can
  // answer later - instead of halting loudly with "no gate handler
  // configured" the moment the run reaches it.
  const done = runLoop(def, {
    registry, cwd, runDir, runId, gate: makeMcpGate(runId, def.rails, gateTimerDeps),
  }).catch((e: unknown) => {
    // Defense in depth only: the pre-flight lintLoop + validateGraph(expandPanels(def))
    // checks above already reject synchronously before 'started' is ever reported, so
    // runLoop should no longer throw before its first emit() call. If it somehow still
    // does (e.g. a future validateGraph rule this pre-flight doesn't mirror), this at
    // least logs instead of crashing the detached promise silently. stderr only: stdout
    // is the live MCP protocol stream.
    console.error(`[looprail mcp] run ${runId} failed to start: ${e instanceof Error ? e.message : String(e)}`)
    return undefined
  }).finally(() => sweepPendingGates(runId))

  return {
    result: textResult({ runId, runDir, status: 'started', name: def.name, goal: def.goal }),
    done,
  }
}

export function registerRunLoopTool(server: McpServer, deps: McpToolDeps): void {
  server.registerTool('run_loop', {
    title: 'Start a looprail run',
    description:
      'Lint and start running a loopfile in the background. Returns immediately with a ' +
      'runId - call run_status with that runId to see progress. Does not wait for the run ' +
      'to finish, since a real run can take minutes and spend real money.',
    inputSchema: {
      file: z.string().optional().describe('Path to the loopfile, relative to cwd (default looprail.yaml)'),
      cwd: z.string().optional().describe('Working directory to run in (default: where looprail mcp was started)'),
    },
  }, async (args) => (await runLoopHandler(args, deps)).result)
}
