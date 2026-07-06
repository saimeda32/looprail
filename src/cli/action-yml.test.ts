import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { parse } from 'yaml'

// The composite GitHub Action at the repo root is production surface the
// unit suite would otherwise never touch - a malformed action.yml only
// fails at a consumer's workflow run time, the worst possible place. This
// pins the contract: inputs/outputs the README documents, composite steps
// that actually thread them through.
test('action.yml is valid YAML with the documented inputs, outputs, and composite run steps', () => {
  const raw = readFileSync(join(__dirname, '..', '..', 'action.yml'), 'utf8')
  const action = parse(raw) as {
    name: string
    inputs: Record<string, { default?: string }>
    outputs: Record<string, { value?: string }>
    runs: { using: string; steps: { id?: string; run?: string; shell?: string }[] }
  }
  expect(action.name).toBe('looprail')
  expect(Object.keys(action.inputs).sort()).toEqual(['auto-approve', 'loopfile', 'version', 'working-directory'])
  expect(action.inputs.loopfile.default).toBe('looprail.yaml')
  expect(action.inputs['auto-approve'].default).toBe('true')
  expect(Object.keys(action.outputs).sort()).toEqual(['cost-usd', 'journal', 'run-id', 'status'])
  for (const out of Object.values(action.outputs)) {
    expect(out.value).toContain('steps.run.outputs')
  }
  expect(action.runs.using).toBe('composite')
  // every composite step must declare its shell - actions/runner hard-errors otherwise
  for (const step of action.runs.steps) {
    expect(step.shell).toBe('bash')
  }
  const runStep = action.runs.steps.find((s) => s.id === 'run')
  expect(runStep?.run).toContain('--json')
  expect(runStep?.run).toContain('GITHUB_OUTPUT')
})
