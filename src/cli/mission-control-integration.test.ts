import { mkdtempSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test  } from 'vitest'

import { runAction } from './run-cmd.js'
import { uiAllAction } from './ui-cmd.js'
import { addWorkspace } from '../workspace/registry.js'
import { latestRunId, workspaceHash } from '../journal/runs.js'
import { startMissionControlServer } from '../dashboard/mission-control-server.js'
import { MockAdapter, createRegistry } from '../index.js'

const FIXTURE = (name: string) => `
name: ${name}
goal: Say DONE.
agents:
  worker:  { adapter: mock }
  checker: { adapter: mock }
graph:
  do:   { role: executor, agent: worker }
  crit: { role: critic, agent: checker, of: do, after: do }
rails:
  max_iterations: 2
  max_cost_usd: 1
`

function capture() {
  const lines: string[] = []
  return { io: { out: (l: string) => lines.push(l) }, lines }
}

let cleanup: (() => Promise<void>) | undefined
afterEach(async () => { if (cleanup) await cleanup(); cleanup = undefined })

function get(url: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let body = ''
      res.on('data', (c) => { body += c })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
    }).on('error', reject)
  })
}

function basenameOf(path: string): string {
  return path.split('/').pop()!
}

test('two independent projects, each run separately, both show up together in mission control', async () => {
  const registryPath = join(mkdtempSync(join(tmpdir(), 'lr-mc-int-reg-')), 'workspaces.json')

  const scrumlo = mkdtempSync(join(tmpdir(), 'lr-mc-int-scrumlo-'))
  writeFileSync(join(scrumlo, 'looprail.yaml'), FIXTURE('scrumlo-loop'))
  const scrumloCode = await runAction(undefined, { cwd: scrumlo, json: true }, { io: capture().io, registryPath })
  expect(scrumloCode).toBe(0)

  const finch = mkdtempSync(join(tmpdir(), 'lr-mc-int-finch-'))
  writeFileSync(join(finch, 'looprail.yaml'), FIXTURE('finch-loop'))
  const finchCode = await runAction(undefined, { cwd: finch, json: true }, { io: capture().io, registryPath })
  expect(finchCode).toBe(0)

  const { io } = capture()
  const result = await uiAllAction({ registryPath }, io)
  cleanup = () => result.dashboard!.close()

  const res = await get(result.dashboard!.url + '/api/runs')
  const runs = JSON.parse(res.body).runs as {
    workspaceName: string; status: string; agents: string[]; workspaceHash: string; runId: string
  }[]
  expect(runs).toHaveLength(2)
  expect(runs.map((r) => r.workspaceName).sort()).toEqual([basenameOf(finch), basenameOf(scrumlo)].sort())
  expect(runs.every((r) => r.status === 'verified')).toBe(true)
  expect(runs.every((r) => r.agents.includes('worker'))).toBe(true)

  const target = runs.find((r) => r.workspaceName === basenameOf(scrumlo))!
  const modelRes = await get(`${result.dashboard!.url}/run/${target.workspaceHash}/${target.runId}/model`)
  expect(JSON.parse(modelRes.body).name).toBe('scrumlo-loop')
})

test('after two runs, `workspace list` shows both projects without any explicit `workspace add`', async () => {
  const registryPath = join(mkdtempSync(join(tmpdir(), 'lr-mc-int-reg-')), 'workspaces.json')

  const a = mkdtempSync(join(tmpdir(), 'lr-mc-int-a-'))
  writeFileSync(join(a, 'looprail.yaml'), FIXTURE('a-loop'))
  await runAction(undefined, { cwd: a, json: true }, { io: capture().io, registryPath })

  const b = mkdtempSync(join(tmpdir(), 'lr-mc-int-b-'))
  writeFileSync(join(b, 'looprail.yaml'), FIXTURE('b-loop'))
  await runAction(undefined, { cwd: b, json: true }, { io: capture().io, registryPath })

  const { workspaceListAction } = await import('./workspace-cmd.js')
  const { io, lines } = capture()
  workspaceListAction({ cwd: '/irrelevant', registryPath }, io)
  expect(lines.join('\n')).toContain(a)
  expect(lines.join('\n')).toContain(b)
})

// The run page's diagnosis panel is fed by GET /run/<hash>/<runId>/why -
// the same engine behind the CLI's why command, served over HTTP.
test('/why on a halted run returns the plain-language diagnosis', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'lr-mc-why-'))
  const registryPath = join(cwd, 'registry.json')
  addWorkspace(registryPath, cwd)
  writeFileSync(join(cwd, 'looprail.yaml'), `
name: why-int
goal: never passes
agents: { m: { adapter: mock } }
graph:
  do:  { role: executor, agent: m }
  bad: { role: tester, after: do, run: "false", expect: exit 0 }
rails: { max_iterations: 2, max_cost_usd: 1 }
`)
  const registry = createRegistry()
  registry.register(new MockAdapter(Array.from({ length: 12 }, () => ({ output: 'work' }))))
  await runAction(undefined, { cwd, json: true }, { io: { out: () => {} }, registry })
  const runId = latestRunId(cwd)!
  const dash = await startMissionControlServer({ registryPath })
  try {
    const res = await get(`${dash.url}/run/${workspaceHash(cwd)}/${runId}/why`)
    expect(res.status).toBe(200)
    const d = JSON.parse(res.body) as { status: string; headline: string; nextSteps: string[] }
    expect(d.status).toBe('halted')
    expect(d.headline.length).toBeGreaterThan(10)
    expect(d.nextSteps.length).toBeGreaterThan(0)
  } finally {
    await dash.close()
  }
})
