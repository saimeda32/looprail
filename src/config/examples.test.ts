import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'
import { lintLoop } from './lint.js'
import { parseLoopfile } from './loopfile.js'

const examplesDir = fileURLToPath(new URL('../../examples', import.meta.url))

describe('examples/ stay lint-clean (spec §3.3: CI enforces)', () => {
  const dirs = readdirSync(examplesDir)
  test('at least one example ships', () => {
    expect(dirs.length).toBeGreaterThan(0)
  })
  for (const dir of dirs) {
    test(`examples/${dir}/looprail.yaml parses and lints clean`, () => {
      const text = readFileSync(join(examplesDir, dir, 'looprail.yaml'), 'utf8')
      expect(lintLoop(parseLoopfile(text))).toEqual([])
    })
  }
})
