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
    // every .yaml in the example is enforced, not only looprail.yaml - an
    // example may ship additional loopfiles (overnight-queue's
    // release-check.yaml) and queue files, and a broken secondary file is
    // just as bad a first impression as a broken primary one.
    const yamls = readdirSync(join(examplesDir, dir)).filter((f) => f.endsWith('.yaml'))
    for (const file of yamls) {
      if (file === 'queue.yaml') {
        test(`examples/${dir}/${file} parses as a valid queue file`, async () => {
          const { parseQueueFile } = await import('../cli/queue-cmd.js')
          const text = readFileSync(join(examplesDir, dir, file), 'utf8')
          expect(parseQueueFile(text).length).toBeGreaterThan(0)
        })
        continue
      }
      test(`examples/${dir}/${file} parses and lints clean`, () => {
        const text = readFileSync(join(examplesDir, dir, file), 'utf8')
        expect(lintLoop(parseLoopfile(text))).toEqual([])
      })
    }
  }
})
