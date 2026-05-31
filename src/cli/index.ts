#!/usr/bin/env node
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { Command } from 'commander'

const pkg = createRequire(import.meta.url)('../../package.json') as { version: string }

export function buildProgram(): Command {
  const program = new Command()
  program
    .name('looprail')
    .description('Vendor-neutral orchestrator for agentic loops — engineer the loop that decides when work is actually done')
    .version(pkg.version)
    .option('--cwd <dir>', 'working directory', process.cwd())
  // command modules register themselves here (Tasks 7-11)
  return program
}

const isMain =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href

if (isMain) {
  buildProgram()
    .parseAsync(process.argv)
    .catch((e: unknown) => {
      console.error(e instanceof Error ? e.message : String(e))
      process.exitCode = 1
    })
}
