import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

// Detects the repo's real test command at `looprail init` time, so the
// scaffolded loopfile's tester node runs THIS project's actual suite
// instead of a hardcoded `npm test` the user has to notice and hand-edit.
// A tester wired to the wrong command is worse than none: it either fails
// instantly (command not found - loud, but a bad first impression) or,
// far worse, exits 0 without testing anything and "verifies" unverified
// work. Detection is deliberately conservative: only well-known ecosystem
// markers, first match wins, undefined when nothing is recognizably there.
export interface DetectedTestCommand {
  command: string
  // human-readable provenance ("package.json scripts.test") - printed by
  // init so the user can immediately see WHY this command was chosen and
  // correct it if the heuristic guessed wrong.
  source: string
}

export function detectTestCommand(cwd: string): DetectedTestCommand | undefined {
  // package.json first: the most explicit signal there is - the author
  // literally wrote down their test command. npm fills scripts.test with a
  // placeholder that just exits 1 ("no test specified") on `npm init`, so
  // that exact default is treated as absent, not as a real suite.
  try {
    const pkg = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>
    }
    const script = pkg.scripts?.test
    if (script && !script.includes('no test specified')) {
      return { command: 'npm test', source: 'package.json scripts.test' }
    }
  } catch {
    // no package.json, or unparsable - fall through to other ecosystems
  }

  if (existsSync(join(cwd, 'go.mod'))) {
    return { command: 'go test ./...', source: 'go.mod' }
  }
  if (existsSync(join(cwd, 'Cargo.toml'))) {
    return { command: 'cargo test', source: 'Cargo.toml' }
  }
  if (existsSync(join(cwd, 'pytest.ini')) || existsSync(join(cwd, 'tox.ini'))) {
    return { command: 'pytest', source: 'pytest.ini/tox.ini' }
  }
  try {
    const pyproject = readFileSync(join(cwd, 'pyproject.toml'), 'utf8')
    if (pyproject.includes('[tool.pytest')) {
      return { command: 'pytest', source: 'pyproject.toml [tool.pytest]' }
    }
  } catch {
    // no pyproject.toml
  }
  if (existsSync(join(cwd, 'pom.xml'))) {
    return { command: 'mvn test', source: 'pom.xml' }
  }
  if (existsSync(join(cwd, 'build.gradle')) || existsSync(join(cwd, 'build.gradle.kts'))) {
    return { command: 'gradle test', source: 'build.gradle' }
  }
  // Makefile last: `make test` is a convention, not a manifest - only
  // trust it when a test target is actually declared.
  try {
    const makefile = readFileSync(join(cwd, 'Makefile'), 'utf8')
    if (/^test\s*:/m.test(makefile)) {
      return { command: 'make test', source: 'Makefile test target' }
    }
  } catch {
    // no Makefile
  }
  return undefined
}
