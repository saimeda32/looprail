import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { parse } from 'yaml'

// Guards the installable skill pack (skills/looprail/SKILL.md) against rot.
// The skills CLI (`npx skills add saimeda32/looprail`) requires frontmatter
// with name + description; and every command the skill teaches an agent to
// run must actually exist in this CLI - a skill naming a command we renamed
// or removed would walk agents into errors on users' machines.
const raw = readFileSync(join(__dirname, '../../skills/looprail/SKILL.md'), 'utf8')

describe('skills/looprail/SKILL.md', () => {
  test('has the frontmatter the skills CLI requires (name + description)', () => {
    const match = /^---\n([\s\S]*?)\n---/.exec(raw)
    expect(match).not.toBeNull()
    const fm = parse(match![1]) as { name?: string; description?: string }
    expect(fm.name).toBe('looprail')
    expect(typeof fm.description).toBe('string')
    expect(fm.description!.length).toBeGreaterThan(40) // a real trigger description, not a stub
  })

  test('every looprail subcommand the skill names exists in the CLI', async () => {
    const { buildProgram } = await import('../cli/index.js')
    const real = new Set(buildProgram().commands.map((c) => c.name()))
    const named = [...raw.matchAll(/`looprail ([a-z-]+)/g)].map((m) => m[1])
    expect(named.length).toBeGreaterThan(5) // the doc really does teach commands
    for (const cmd of new Set(named)) {
      expect(real, `SKILL.md names \`looprail ${cmd}\` but the CLI has no such command`).toContain(cmd)
    }
  })

  test('teaches the current on-ramps: demo, templates, and --dry-run', () => {
    expect(raw).toContain('looprail demo')
    expect(raw).toContain('looprail templates')
    expect(raw).toContain('--dry-run')
  })
})
