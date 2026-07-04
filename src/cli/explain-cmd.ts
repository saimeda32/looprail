import type { Command } from 'commander'
import { composeContext, type NodeOutcome, type RunState } from '../index.js'
import { loadLoop } from './run-cmd.js'
import { defaultIo, err, heading, type CliIo } from './ui.js'

export async function explainAction(
  file: string,
  nodeId: string,
  opts: { cwd: string },
  io: CliIo = defaultIo,
): Promise<number> {
  let def
  try {
    def = loadLoop(file, opts.cwd).def
  } catch (e) {
    io.out(err(e instanceof Error ? e.message : String(e)))
    return 1
  }
  const node = def.nodes.find((n) => n.id === nodeId)
  if (!node) {
    io.out(err(`no node "${nodeId}" - nodes: ${def.nodes.map((n) => n.id).join(', ')}`))
    return 1
  }
  const outcomes = new Map<string, NodeOutcome>()
  const deps = [...(node.after ?? []), ...(node.of ? [node.of] : [])]
  for (const dep of deps) {
    outcomes.set(dep, {
      nodeId: dep,
      role: def.nodes.find((n) => n.id === dep)?.role ?? 'executor',
      output: `<output of "${dep}" - placeholder>`,
      verdict: null, costUsd: 0, tokens: 0, durationMs: 0,
    })
  }
  const state: RunState = { plan: '<current plan - placeholder>', iteration: 1, feedback: null }
  io.out(heading(`context node "${node.id}" (${node.role}) would receive:`))
  io.out(composeContext(def, node, state, outcomes))
  return 0
}

export function registerExplain(program: Command): void {
  program
    .command('explain <file> <node>')
    .description('print exactly what context a node would receive (dry-run, placeholders for upstream outputs)')
    .action(async (file: string, node: string, _o: unknown, cmd: Command) => {
      const { cwd } = cmd.optsWithGlobals<{ cwd: string }>()
      process.exitCode = await explainAction(file, node, { cwd })
    })
}
