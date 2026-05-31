import { createRequire } from 'node:module'
import { expect, test } from 'vitest'
import { buildProgram } from './index.js'

const pkg = createRequire(import.meta.url)('../../package.json') as { version: string }

test('help names the program and the global --cwd option', () => {
  const help = buildProgram().helpInformation()
  expect(help).toContain('looprail')
  expect(help).toContain('--cwd')
})

test('--version prints the package.json version', () => {
  const program = buildProgram()
  program.exitOverride()
  let out = ''
  program.configureOutput({ writeOut: (s) => { out += s } })
  expect(() => program.parse(['node', 'looprail', '--version'])).toThrow()
  expect(out.trim()).toBe(pkg.version)
})
