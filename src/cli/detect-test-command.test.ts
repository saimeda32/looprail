import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { detectTestCommand } from './detect-test-command.js'

function dir(): string {
  return mkdtempSync(join(tmpdir(), 'lr-detect-'))
}

test('a package.json with a real test script wins as npm test', () => {
  const cwd = dir()
  writeFileSync(join(cwd, 'package.json'), JSON.stringify({ scripts: { test: 'vitest run' } }))
  expect(detectTestCommand(cwd)).toEqual({ command: 'npm test', source: 'package.json scripts.test' })
})

test("npm init's placeholder test script does not count as a real suite", () => {
  const cwd = dir()
  writeFileSync(join(cwd, 'package.json'), JSON.stringify({
    scripts: { test: 'echo "Error: no test specified" && exit 1' },
  }))
  expect(detectTestCommand(cwd)).toBeUndefined()
})

test('go.mod means go test ./...', () => {
  const cwd = dir()
  writeFileSync(join(cwd, 'go.mod'), 'module example.com/x\n')
  expect(detectTestCommand(cwd)?.command).toBe('go test ./...')
})

test('Cargo.toml means cargo test', () => {
  const cwd = dir()
  writeFileSync(join(cwd, 'Cargo.toml'), '[package]\nname = "x"\n')
  expect(detectTestCommand(cwd)?.command).toBe('cargo test')
})

test('a pyproject.toml with [tool.pytest] means pytest', () => {
  const cwd = dir()
  writeFileSync(join(cwd, 'pyproject.toml'), '[tool.pytest.ini_options]\ntestpaths = ["tests"]\n')
  expect(detectTestCommand(cwd)?.command).toBe('pytest')
})

test('a Makefile only counts when it actually declares a test target', () => {
  const cwd = dir()
  writeFileSync(join(cwd, 'Makefile'), 'build:\n\tgcc main.c\n')
  expect(detectTestCommand(cwd)).toBeUndefined()
  writeFileSync(join(cwd, 'Makefile'), 'build:\n\tgcc main.c\n\ntest:\n\t./run-tests.sh\n')
  expect(detectTestCommand(cwd)?.command).toBe('make test')
})

test('an unrecognizable directory detects nothing - the template keeps its npm test default and swap-it comment', () => {
  expect(detectTestCommand(dir())).toBeUndefined()
})
