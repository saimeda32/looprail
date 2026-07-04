import { expect, test } from 'vitest'
import { parseBenchfile } from './benchfile.js'

const VALID = `
name: demo-bench
task: Fix the failing test
repeat: 5
configs:
  - id: baseline
    loopfile: baseline.yaml
  - id: looprail
    loopfile: looprail.yaml
`

test('parses a valid benchfile into a BenchDef', () => {
  const def = parseBenchfile(VALID)
  expect(def).toEqual({
    name: 'demo-bench',
    task: 'Fix the failing test',
    repeat: 5,
    configs: [
      { id: 'baseline', loopfile: 'baseline.yaml' },
      { id: 'looprail', loopfile: 'looprail.yaml' },
    ],
  })
})

test('lists all missing required fields in one error', () => {
  expect(() => parseBenchfile('name: x')).toThrow(/task[\s\S]*repeat[\s\S]*configs/)
})

test('rejects a non-positive repeat', () => {
  expect(() => parseBenchfile(VALID.replace('repeat: 5', 'repeat: 0'))).toThrow(/repeat must be a positive integer/)
})

test('rejects a non-integer repeat', () => {
  expect(() => parseBenchfile(VALID.replace('repeat: 5', 'repeat: 2.5'))).toThrow(/repeat must be a positive integer/)
})

test('rejects fewer than 2 configs', () => {
  const oneConfig = VALID.replace(/configs:[\s\S]*/, 'configs:\n  - id: baseline\n    loopfile: baseline.yaml\n')
  expect(() => parseBenchfile(oneConfig)).toThrow(/at least 2 named loop configs/)
})

test('rejects a config missing an id', () => {
  const bad = VALID.replace('id: baseline', 'notid: baseline')
  expect(() => parseBenchfile(bad)).toThrow(/missing or empty "id"/)
})

test('rejects a config missing a loopfile', () => {
  const bad = VALID.replace('loopfile: baseline.yaml', 'notloopfile: baseline.yaml')
  expect(() => parseBenchfile(bad)).toThrow(/missing or empty "loopfile"/)
})

test('rejects duplicate config ids', () => {
  const bad = VALID.replace('id: looprail', 'id: baseline')
  expect(() => parseBenchfile(bad)).toThrow(/duplicate config id "baseline"/)
})
