import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Command } from 'commander'
import { addWorkspace, defaultRegistryPath, listWorkspaces, removeWorkspace } from '../workspace/registry.js'
import { defaultIo, dim, err, heading, ok, type CliIo } from './ui.js'

export interface WorkspaceActionOpts {
  cwd: string
  registryPath?: string
}

export function workspaceAddAction(
  path: string | undefined, opts: WorkspaceActionOpts, io: CliIo = defaultIo,
): number {
  const target = resolve(opts.cwd, path ?? '.')
  const registryPath = opts.registryPath ?? defaultRegistryPath()
  if (!existsSync(target)) {
    io.out(err(`no such directory: ${target}`))
    return 1
  }
  addWorkspace(registryPath, target)
  io.out(ok(`registered workspace: ${target}`))
  return 0
}

export function workspaceRemoveAction(
  path: string, opts: WorkspaceActionOpts, io: CliIo = defaultIo,
): number {
  const target = resolve(opts.cwd, path)
  const registryPath = opts.registryPath ?? defaultRegistryPath()
  removeWorkspace(registryPath, target)
  io.out(ok(`removed workspace: ${target}`))
  return 0
}

export function workspaceListAction(opts: WorkspaceActionOpts, io: CliIo = defaultIo): number {
  const registryPath = opts.registryPath ?? defaultRegistryPath()
  const workspaces = listWorkspaces(registryPath)
  if (workspaces.length === 0) {
    io.out(dim('no workspaces registered — `looprail workspace add` in a project directory, or just `looprail run` there (it registers itself automatically)'))
    return 0
  }
  io.out(heading(`${workspaces.length} registered workspace${workspaces.length === 1 ? '' : 's'}`))
  for (const w of workspaces) io.out(`  ${w}`)
  return 0
}

export function registerWorkspace(program: Command): void {
  const cmd = program.command('workspace').description('manage the projects the mission-control dashboard scans')

  cmd.command('add [path]')
    .description('register a project directory (default: current directory)')
    .action((path: string | undefined, _o: unknown, sub: Command) => {
      const { cwd } = sub.optsWithGlobals<{ cwd: string }>()
      process.exitCode = workspaceAddAction(path, { cwd })
    })

  cmd.command('remove <path>')
    .description('unregister a project directory')
    .action((path: string, _o: unknown, sub: Command) => {
      const { cwd } = sub.optsWithGlobals<{ cwd: string }>()
      process.exitCode = workspaceRemoveAction(path, { cwd })
    })

  cmd.command('list')
    .description('list registered project directories')
    .action((_o: unknown, sub: Command) => {
      const { cwd } = sub.optsWithGlobals<{ cwd: string }>()
      process.exitCode = workspaceListAction({ cwd })
    })
}
