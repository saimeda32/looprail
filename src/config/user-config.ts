import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

// User-level defaults at ~/.looprail/config.json - the tool's memory of how
// THIS person likes to work, so nothing has to be re-answered or re-flagged
// on every run. Precedence everywhere a setting applies:
//   explicit flag  >  environment variable  >  this file  >  built-in default
// The file is plain JSON a human can edit directly; `looprail config` is the
// convenience surface over it. Unknown keys are preserved on write (an older
// looprail must never delete a newer one's settings).

export interface UserConfig {
  // Preferred adapters, used as init's pre-selected defaults (a detected
  // adapter list still wins over a preference for something not installed).
  worker?: string
  reviewer?: string
  // Open the dashboard automatically when a gate waits (default true;
  // LOOPRAIL_NO_AUTO_OPEN=1 still force-disables).
  autoOpen?: boolean
  // Desktop notifications (default true; LOOPRAIL_NO_NOTIFY=1 still
  // force-disables).
  notify?: boolean
  // Preferred dashboard port for `run --ui` (CLI --port still wins).
  port?: number
}

// The editable keys, with parsing + validation in one place so `config set`
// and any future settings UI agree about what is legal.
export const CONFIG_KEYS: Record<keyof UserConfig, { parse: (raw: string) => unknown; describe: string }> = {
  worker: { parse: (raw) => raw, describe: 'preferred worker adapter (init default)' },
  reviewer: { parse: (raw) => raw, describe: 'preferred reviewer adapter (init default)' },
  autoOpen: {
    parse: (raw) => {
      if (raw !== 'true' && raw !== 'false') throw new Error('autoOpen must be true or false')
      return raw === 'true'
    },
    describe: 'open the dashboard automatically when a gate waits (true/false)',
  },
  notify: {
    parse: (raw) => {
      if (raw !== 'true' && raw !== 'false') throw new Error('notify must be true or false')
      return raw === 'true'
    },
    describe: 'desktop notifications (true/false)',
  },
  port: {
    parse: (raw) => {
      const n = Number(raw)
      if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error('port must be an integer between 1 and 65535')
      return n
    },
    describe: 'preferred dashboard port for run --ui',
  },
}

export function defaultConfigPath(): string {
  return join(homedir(), '.looprail', 'config.json')
}

// Reading is forgiving: a missing file is an empty config, and a corrupt one
// is reported by the caller that cares (`config` command) but never crashes
// a run - a broken preferences file must not break the tool.
export function readUserConfig(path: string = defaultConfigPath()): UserConfig {
  if (!existsSync(path)) return {}
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
    return raw as UserConfig
  } catch {
    return {}
  }
}

export function writeUserConfig(patch: Partial<UserConfig>, path: string = defaultConfigPath()): UserConfig {
  // merge over the raw file content (not the typed view) so unknown keys
  // written by a newer version survive a round-trip through this one
  let existing: Record<string, unknown> = {}
  if (existsSync(path)) {
    try {
      existing = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
    } catch {
      existing = {} // corrupt file: start clean rather than fail forever
    }
  }
  const merged: Record<string, unknown> = { ...existing, ...patch }
  // an explicit undefined in the patch means "unset this key"
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) delete merged[k]
  }
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(merged, null, 2) + '\n')
  return merged as UserConfig
}
