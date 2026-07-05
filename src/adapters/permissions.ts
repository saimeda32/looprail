export type PermissionPreset = 'safe' | 'standard' | 'full'

export interface PermissionRawConfig {
  preset?: PermissionPreset
  // Keyed by the exact same adapter-name strings used for AgentDef.adapter
  // elsewhere in the loopfile (claude-code, codex, copilot-cli, aider) - not
  // a separate naming convention, so switching an agent's adapter doesn't
  // silently keep applying another adapter's raw flags to it.
  raw?: Partial<Record<string, string[]>>
}

export type PermissionConfig = PermissionPreset | PermissionRawConfig

// Verified against each adapter's own real, current --help output
// (2026-07-05), not assumed. aider has no fine-grained per-tool model at
// all - every preset below is deliberately the same empty result, since its
// one real switch (--yes-always) is already unconditionally present in its
// command template (see aider.ts) and there is nothing finer to add.
const PRESET_FLAGS: Record<string, Record<PermissionPreset, string[]>> = {
  'claude-code': {
    safe: ['--permission-mode', 'acceptEdits'],
    standard: ['--permission-mode', 'auto'],
    full: ['--dangerously-skip-permissions'],
  },
  codex: {
    safe: ['--sandbox', 'workspace-write', '--ask-for-approval', 'on-request'],
    standard: ['--sandbox', 'workspace-write', '--ask-for-approval', 'never'],
    full: ['--sandbox', 'danger-full-access', '--ask-for-approval', 'never'],
  },
  'copilot-cli': {
    safe: ['--allow-tool', 'write', '--allow-tool', 'shell(npm:*)'],
    standard: ['--allow-all-tools'],
    full: ['--allow-all-tools', '--allow-all-paths', '--allow-all-urls'],
  },
  aider: {
    safe: [],
    standard: [],
    full: [],
  },
}

// Absent config must reproduce each adapter's real behavior from before this
// feature existed: copilot-cli's command template already hardcoded
// unconditional --allow-all-tools (full), while claude-code/codex/aider
// passed no permission flags at all (closest real equivalent is safe - it
// only ever grants permission, never revokes one that was already working).
const DEFAULT_PRESET: Record<string, PermissionPreset> = {
  'claude-code': 'safe',
  codex: 'safe',
  'copilot-cli': 'full',
  aider: 'safe',
}

export function resolvePermissionArgs(
  config: PermissionConfig | undefined, adapterName: string,
): string[] {
  const presetTable = PRESET_FLAGS[adapterName] ?? {}
  let presetArgs: string[] = []
  let rawArgs: string[] = []

  if (config === undefined) {
    presetArgs = presetTable[DEFAULT_PRESET[adapterName]] ?? []
  } else if (typeof config === 'string') {
    presetArgs = presetTable[config] ?? []
  } else {
    if (config.preset) presetArgs = presetTable[config.preset] ?? []
    rawArgs = config.raw?.[adapterName] ?? []
  }

  return [...presetArgs, ...rawArgs]
}
