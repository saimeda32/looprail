import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Command } from 'commander'
import { lintLoop, parseLoopfile } from '../index.js'
import { defaultIo, err, ok, warn, type CliIo } from './ui.js'

export async function lintAction(
  file: string | undefined,
  opts: { cwd: string },
  io: CliIo = defaultIo,
): Promise<number> {
  // same default as `run`: no argument means the cwd's looprail.yaml
  const path = resolve(opts.cwd, file ?? 'looprail.yaml')
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    io.out(err(`cannot read ${path} - does the file exist?`))
    return 1
  }
  let def
  try {
    def = parseLoopfile(text)
  } catch (e) {
    io.out(err(e instanceof Error ? e.message : String(e)))
    return 1
  }
  const findings = lintLoop(def)
  if (findings.length === 0) {
    io.out(ok('lint clean - no findings'))
    return 0
  }
  for (const f of findings) {
    const tag = f.level === 'error' ? err(`${f.rule} error`) : warn(`${f.rule} warn`)
    io.out(`${tag} ${f.node ? `[${f.node}] ` : ''}${f.message}`)
  }
  return findings.some((f) => f.level === 'error') ? 1 : 0
}

export function registerLint(program: Command): void {
  program
    .command('lint [file]')
    .description('statically validate a loopfile (termination path, rails, self-judging, ...)')
    .action(async (file: string | undefined, _opts: unknown, cmd: Command) => {
      const { cwd } = cmd.optsWithGlobals<{ cwd: string }>()
      process.exitCode = await lintAction(file, { cwd })
    })
}
