import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

// Every real install invokes this CLI through a SYMLINK (npm -g bin links,
// npx cache .bin links). The is-main guard used to compare the UNRESOLVED
// argv[1] against import.meta.url, making every symlinked invocation a
// silent no-op with exit 0 - `looprail --version` printed nothing for every
// npm/npx user while `node dist/cli/index.js` worked fine, which is exactly
// why no direct-invocation test ever caught it. These tests execute the
// built entry the way installs actually do.
const entry = resolve(__dirname, '../../dist/cli/index.js')
const run = (argv1: string): string =>
  execFileSync(process.execPath, [argv1, '--version'], { encoding: 'utf8', timeout: 20_000 })

describe.skipIf(!existsSync(entry))('bin entry (requires a build - npm run build)', () => {
  test('direct invocation prints the version', () => {
    expect(run(entry).trim()).toMatch(/^\d+\.\d+\.\d+/)
  })

  test('SYMLINKED invocation (how npm -g and npx actually run it) prints the version', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lr-bin-'))
    const link = join(dir, 'looprail')
    symlinkSync(entry, link)
    expect(run(link).trim()).toMatch(/^\d+\.\d+\.\d+/)
  })
})
