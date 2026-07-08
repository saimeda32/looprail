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
  // gemini's --approval-mode choices (default | auto_edit | yolo | plan) are
  // verified against the real v0.49.0 `gemini --help`, run live via npx.
  // safe -> auto_edit mirrors claude-code's acceptEdits: edits auto-approve,
  // anything riskier stays gated by the CLI's own policy. standard and full
  // are deliberately the same yolo result - gemini has nothing looser than
  // yolo (its only other lever, --sandbox, is deliberately NOT toggled here:
  // it requires a container runtime the host can't be assumed to have, so
  // flipping it on would break machines without docker/podman rather than
  // loosen anything).
  gemini: {
    safe: ['--approval-mode', 'auto_edit'],
    standard: ['--approval-mode', 'yolo'],
    full: ['--approval-mode', 'yolo'],
  },
  // opencode's CLI surface has exactly one permission switch, verified
  // against the real v1.17.14 `opencode run --help` (run live via npx):
  // --auto, "auto-approve permissions that are not explicitly denied
  // (dangerous!)". Anything finer lives in the user's own opencode.json
  // permission config, out of a one-shot CLI invocation's reach - so safe
  // and standard are deliberately the same empty result (defer to that
  // config; per the v1.17.14 run.ts source, non-interactive opencode
  // auto-REJECTS anything the config gates rather than hanging), and only
  // full flips the CLI's own escalation switch.
  opencode: {
    safe: [],
    standard: [],
    full: ['--auto'],
  },
  // ollama runs no tools at all - `ollama run` only generates text, so there
  // is no permission surface for any preset to widen or narrow. Every preset
  // is deliberately the same empty result (aider precedent); the raw escape
  // hatch below still works for passing ollama's own non-permission flags.
  ollama: {
    safe: [],
    standard: [],
    full: [],
  },
  // antigravity (`agy`): NOT live-verified - no install was available on
  // this machine (see antigravity.ts's header for the sourcing). --sandbox
  // ("runs with terminal restrictions") and --dangerously-skip-permissions
  // are its two documented levers. standard is deliberately empty: the
  // CLI's own default approval policy stands, and print mode is expected to
  // policy-deny rather than hang (gemini-lineage behavior) - re-verify
  // against a real `agy --help` when one is available.
  antigravity: {
    safe: ['--sandbox'],
    standard: [],
    full: ['--dangerously-skip-permissions'],
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
  // No pre-feature behavior to reproduce for the adapters added after the
  // permissions feature (gemini, opencode, ollama) - safe is simply the
  // conservative choice every non-copilot adapter already defaults to.
  gemini: 'safe',
  opencode: 'safe',
  ollama: 'safe',
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
