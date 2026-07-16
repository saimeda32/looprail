import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { CONFIG_KEYS, readUserConfig, writeUserConfig } from './user-config.js'

const tmpPath = () => join(mkdtempSync(join(tmpdir(), 'lr-cfg-')), 'config.json')

describe('user config', () => {
  test('missing file reads as empty; write then read round-trips', () => {
    const p = tmpPath()
    expect(readUserConfig(p)).toEqual({})
    writeUserConfig({ worker: 'claude-code', autoOpen: false }, p)
    expect(readUserConfig(p)).toEqual({ worker: 'claude-code', autoOpen: false })
  })

  test('unknown keys from a newer version survive a write from this one', () => {
    const p = tmpPath()
    writeFileSync(p, JSON.stringify({ futureKey: 'keep me', worker: 'codex' }))
    writeUserConfig({ worker: 'claude-code' }, p)
    const raw = readUserConfig(p) as Record<string, unknown>
    expect(raw.futureKey).toBe('keep me')
    expect(raw.worker).toBe('claude-code')
  })

  test('explicit undefined unsets a key', () => {
    const p = tmpPath()
    writeUserConfig({ worker: 'codex', notify: false }, p)
    writeUserConfig({ worker: undefined }, p)
    expect(readUserConfig(p)).toEqual({ notify: false })
  })

  test('a corrupt file reads as empty, never throws', () => {
    const p = tmpPath()
    writeFileSync(p, '{not json')
    expect(readUserConfig(p)).toEqual({})
  })

  test('key parsers validate: booleans and port range', () => {
    expect(CONFIG_KEYS.autoOpen.parse('true')).toBe(true)
    expect(() => CONFIG_KEYS.autoOpen.parse('yes')).toThrow(/true or false/)
    expect(CONFIG_KEYS.port.parse('4747')).toBe(4747)
    expect(() => CONFIG_KEYS.port.parse('99999')).toThrow(/between/)
    expect(() => CONFIG_KEYS.port.parse('abc')).toThrow(/between/)
  })
})
