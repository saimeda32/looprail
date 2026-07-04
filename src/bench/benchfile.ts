import { parse } from 'yaml'
import type { BenchConfigRef, BenchDef } from './types.js'

function isPositiveInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v > 0
}

export function parseBenchfile(text: string): BenchDef {
  const raw = parse(text) as Record<string, unknown>
  const problems: string[] = []
  for (const field of ['name', 'task', 'repeat', 'configs']) {
    if (raw?.[field] === undefined) problems.push(`missing required field "${field}"`)
  }
  if (problems.length > 0) throw new Error(`invalid benchfile:\n${problems.join('\n')}`)

  if (!isPositiveInt(raw.repeat)) {
    problems.push('repeat must be a positive integer')
  }

  const rawConfigs = raw.configs
  let configs: BenchConfigRef[] = []
  if (!Array.isArray(rawConfigs) || rawConfigs.length < 2) {
    problems.push('configs must be an array of at least 2 named loop configs')
  } else {
    const seen = new Set<string>()
    rawConfigs.forEach((c: unknown, i: number) => {
      const entry = (c ?? {}) as Record<string, unknown>
      const id = entry.id
      const loopfile = entry.loopfile
      if (typeof id !== 'string' || id.trim() === '') {
        problems.push(`configs[${i}]: missing or empty "id"`)
      } else if (seen.has(id)) {
        problems.push(`configs[${i}]: duplicate config id "${id}"`)
      } else {
        seen.add(id)
      }
      if (typeof loopfile !== 'string' || loopfile.trim() === '') {
        problems.push(`configs[${i}]: missing or empty "loopfile"`)
      }
    })
    configs = rawConfigs.map((c) => {
      const entry = c as Record<string, unknown>
      return { id: entry.id as string, loopfile: entry.loopfile as string }
    })
  }

  if (problems.length > 0) throw new Error(`invalid benchfile:\n${problems.join('\n')}`)

  return {
    name: raw.name as string,
    task: raw.task as string,
    repeat: raw.repeat as number,
    configs,
  }
}
