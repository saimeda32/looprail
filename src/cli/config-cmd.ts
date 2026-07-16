import type { Command } from 'commander'
import {
  CONFIG_KEYS, defaultConfigPath, readUserConfig, writeUserConfig, type UserConfig,
} from '../config/user-config.js'
import { defaultIo, dim, err, ok, renderTable, type CliIo } from './ui.js'

// `looprail config` - the tool's memory of how you like to work:
//   looprail config                 show every setting and where it lives
//   looprail config set worker codex
//   looprail config unset worker
// Precedence wherever a setting applies: flag > env > config file > default.

const KEY_NAMES = Object.keys(CONFIG_KEYS) as Array<keyof UserConfig>

export function configAction(
  args: string[],
  deps: { io?: CliIo; path?: string } = {},
): number {
  const io = deps.io ?? defaultIo
  const path = deps.path ?? defaultConfigPath()
  const [verb, key, value] = args

  if (!verb) {
    const cfg = readUserConfig(path) as Record<string, unknown>
    io.out(renderTable(
      ['setting', 'value', 'what it does'],
      KEY_NAMES.map((k) => [k, cfg[k] === undefined ? dim('(unset)') : String(cfg[k]), CONFIG_KEYS[k].describe]),
    ))
    io.out(dim(`  file: ${path} - flags and env vars always win over these`))
    return 0
  }

  if (verb === 'set') {
    if (!key || value === undefined) {
      io.out(err('usage: looprail config set <key> <value>'))
      return 1
    }
    const spec = CONFIG_KEYS[key as keyof UserConfig]
    if (!spec) {
      io.out(err(`unknown setting "${key}" - one of: ${KEY_NAMES.join(', ')}`))
      return 1
    }
    let parsed: unknown
    try {
      parsed = spec.parse(value)
    } catch (e) {
      io.out(err(e instanceof Error ? e.message : String(e)))
      return 1
    }
    writeUserConfig({ [key]: parsed } as Partial<UserConfig>, path)
    io.out(ok(`${key} = ${String(parsed)}`))
    return 0
  }

  if (verb === 'unset') {
    if (!key || !CONFIG_KEYS[key as keyof UserConfig]) {
      io.out(err(`usage: looprail config unset <key> - one of: ${KEY_NAMES.join(', ')}`))
      return 1
    }
    writeUserConfig({ [key]: undefined } as Partial<UserConfig>, path)
    io.out(ok(`${key} unset`))
    return 0
  }

  io.out(err(`unknown subcommand "${verb}" - use \`looprail config\`, \`config set <key> <value>\`, or \`config unset <key>\``))
  return 1
}

export function registerConfig(program: Command): void {
  program
    .command('config [args...]')
    .description('show or change your personal defaults (worker/reviewer adapters, auto-open, notifications, port)')
    .action((args: string[]) => {
      process.exitCode = configAction(args ?? [])
    })
}
