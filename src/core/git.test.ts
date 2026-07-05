import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { filesTouched } from './git.js'

const initRepo = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'looprail-git-test-'))
  execFileSync('git', ['init', '-q'], { cwd: dir })
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir })
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir })
  return dir
}

test('returns an empty list for a directory that is not a git repo', () => {
  const dir = mkdtempSync(join(tmpdir(), 'looprail-nongit-'))
  try {
    expect(filesTouched(dir)).toEqual([])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('degrades gracefully (empty list) for a nonexistent cwd instead of throwing', () => {
  expect(filesTouched(join(tmpdir(), 'looprail-does-not-exist-xyz'))).toEqual([])
})

test('picks up a brand-new untracked file', () => {
  const dir = initRepo()
  try {
    writeFileSync(join(dir, 'new-file.txt'), 'hello')
    expect(filesTouched(dir)).toEqual(['new-file.txt'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('picks up a modification to an already-committed file', () => {
  const dir = initRepo()
  try {
    writeFileSync(join(dir, 'existing.txt'), 'v1')
    execFileSync('git', ['add', '.'], { cwd: dir })
    execFileSync('git', ['commit', '-q', '-m', 'initial'], { cwd: dir })
    writeFileSync(join(dir, 'existing.txt'), 'v2')
    expect(filesTouched(dir)).toEqual(['existing.txt'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('reports a nested-directory file with its full relative path, deduped and sorted', () => {
  const dir = initRepo()
  try {
    mkdirSync(join(dir, 'sub'))
    writeFileSync(join(dir, 'sub', 'a.txt'), 'a')
    writeFileSync(join(dir, 'z.txt'), 'z')
    writeFileSync(join(dir, 'b.txt'), 'b')
    expect(filesTouched(dir)).toEqual(['b.txt', 'sub/a.txt', 'z.txt'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('resolves a rename to its new path only', () => {
  const dir = initRepo()
  try {
    writeFileSync(join(dir, 'old-name.txt'), 'content')
    execFileSync('git', ['add', '.'], { cwd: dir })
    execFileSync('git', ['commit', '-q', '-m', 'initial'], { cwd: dir })
    execFileSync('git', ['mv', 'old-name.txt', 'new-name.txt'], { cwd: dir })
    execFileSync('git', ['add', '-A'], { cwd: dir })
    expect(filesTouched(dir)).toEqual(['new-name.txt'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
