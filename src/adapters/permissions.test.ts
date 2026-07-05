import { describe, expect, test } from 'vitest'
import { resolvePermissionArgs } from './permissions.js'

describe('resolvePermissionArgs - explicit presets', () => {
  test('claude-code: safe/standard/full map to their real, distinct flags', () => {
    expect(resolvePermissionArgs('safe', 'claude-code')).toEqual(['--permission-mode', 'acceptEdits'])
    expect(resolvePermissionArgs('standard', 'claude-code')).toEqual(['--permission-mode', 'auto'])
    expect(resolvePermissionArgs('full', 'claude-code')).toEqual(['--dangerously-skip-permissions'])
  })

  test('codex: safe/standard/full map to their real, distinct flags', () => {
    expect(resolvePermissionArgs('safe', 'codex')).toEqual(['--sandbox', 'workspace-write', '--ask-for-approval', 'on-request'])
    expect(resolvePermissionArgs('standard', 'codex')).toEqual(['--sandbox', 'workspace-write', '--ask-for-approval', 'never'])
    expect(resolvePermissionArgs('full', 'codex')).toEqual(['--sandbox', 'danger-full-access', '--ask-for-approval', 'never'])
  })

  test('copilot-cli: safe is scoped, standard/full both allow everything but differ on path/url access', () => {
    expect(resolvePermissionArgs('safe', 'copilot-cli')).toEqual(['--allow-tool', 'write', '--allow-tool', 'shell(npm:*)'])
    expect(resolvePermissionArgs('standard', 'copilot-cli')).toEqual(['--allow-all-tools'])
    expect(resolvePermissionArgs('full', 'copilot-cli')).toEqual(['--allow-all-tools', '--allow-all-paths', '--allow-all-urls'])
  })

  test('aider: every preset resolves to the same empty result - it has no finer granularity than its own hardcoded --yes-always', () => {
    expect(resolvePermissionArgs('safe', 'aider')).toEqual([])
    expect(resolvePermissionArgs('standard', 'aider')).toEqual([])
    expect(resolvePermissionArgs('full', 'aider')).toEqual([])
  })
})

describe('resolvePermissionArgs - absent config (backward compatibility)', () => {
  test('copilot-cli with no config resolves to full, preserving its current hardcoded --allow-all-tools behavior', () => {
    expect(resolvePermissionArgs(undefined, 'copilot-cli')).toEqual(resolvePermissionArgs('full', 'copilot-cli'))
  })

  test('claude-code/codex/aider with no config resolve to safe, since neither passed any permission flags before this feature existed', () => {
    expect(resolvePermissionArgs(undefined, 'claude-code')).toEqual(resolvePermissionArgs('safe', 'claude-code'))
    expect(resolvePermissionArgs(undefined, 'codex')).toEqual(resolvePermissionArgs('safe', 'codex'))
    expect(resolvePermissionArgs(undefined, 'aider')).toEqual(resolvePermissionArgs('safe', 'aider'))
  })
})

describe('resolvePermissionArgs - raw escape hatch', () => {
  test('raw flags for the matching adapter append after the preset flags', () => {
    const config = { preset: 'safe' as const, raw: { 'claude-code': ['--add-dir', './scripts'] } }
    expect(resolvePermissionArgs(config, 'claude-code')).toEqual(['--permission-mode', 'acceptEdits', '--add-dir', './scripts'])
  })

  test('raw-only config (no preset field) applies only the raw flags, with no preset flags at all', () => {
    const config = { raw: { 'copilot-cli': ['--allow-tool', 'shell(git:*)'] } }
    expect(resolvePermissionArgs(config, 'copilot-cli')).toEqual(['--allow-tool', 'shell(git:*)'])
  })

  test('a raw key for a different adapter than the one being resolved contributes nothing', () => {
    const config = { preset: 'safe' as const, raw: { 'codex': ['--sandbox', 'danger-full-access'] } }
    expect(resolvePermissionArgs(config, 'claude-code')).toEqual(['--permission-mode', 'acceptEdits'])
  })

  test('raw-only config with no matching adapter key and no preset resolves to an empty array', () => {
    const config = { raw: { 'codex': ['--sandbox', 'danger-full-access'] } }
    expect(resolvePermissionArgs(config, 'claude-code')).toEqual([])
  })
})
