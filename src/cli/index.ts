#!/usr/bin/env node
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { Command } from 'commander'
import { registerBench } from './bench-cmd.js'
import { registerDemo } from './demo-cmd.js'
import { registerDoctor } from './doctor-cmd.js'
import { registerExplain } from './explain-cmd.js'
import { registerInit } from './init-cmd.js'
import { registerLedger } from './ledger-cmd.js'
import { registerLint } from './lint-cmd.js'
import { registerQueue } from './queue-cmd.js'
import { registerReplay } from './replay-cmd.js'
import { registerResume } from './resume-cmd.js'
import { registerRoute } from './route-cmd.js'
import { registerRun } from './run-cmd.js'
import { registerSpend } from './spend-cmd.js'
import { registerTemplates } from './templates-cmd.js'
import { registerLogs, registerStatus } from './status-cmd.js'
import { registerMcp } from './mcp-cmd.js'
import { registerUi } from './ui-cmd.js'
import { registerWorkspace } from './workspace-cmd.js'

const pkg = createRequire(import.meta.url)('../../package.json') as { version: string }

export function buildProgram(): Command {
  const program = new Command()
  program
    .name('looprail')
    .description('Vendor-neutral orchestrator for agentic loops - engineer the loop that decides when work is actually done')
    .version(pkg.version)
    .option('--cwd <dir>', 'working directory', process.cwd())
  // command modules register themselves here (Tasks 7-11)
  registerDemo(program)
  registerDoctor(program)
  registerInit(program)
  registerTemplates(program)
  registerLint(program)
  registerLedger(program)
  registerSpend(program)
  registerRun(program)
  registerQueue(program)
  registerBench(program)
  registerRoute(program)
  registerReplay(program)
  registerResume(program)
  registerStatus(program)
  registerLogs(program)
  registerExplain(program)
  registerUi(program)
  registerWorkspace(program)
  registerMcp(program)
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
