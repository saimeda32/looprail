import { mkdtempSync, writeFileSync, appendFileSync } from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { startDashboardServer, type DashboardServer } from './server.js'

let dashboard: DashboardServer | undefined

afterEach(async () => {
  if (dashboard) await dashboard.close()
  dashboard = undefined
})

function get(url: string): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let body = ''
      res.on('data', (chunk) => { body += chunk })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }))
    }).on('error', reject)
  })
}

function journalWith(lines: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'lr-dash-'))
  const path = join(dir, 'journal.jsonl')
  writeFileSync(path, lines.map((l) => l + '\n').join(''))
  return path
}

test('GET / serves the self-contained HTML page', async () => {
  const journalPath = journalWith(['{"ts":1,"type":"run_start","data":{"runId":"r","name":"n","goal":"g"}}'])
  dashboard = await startDashboardServer({ journalPath })
  expect(dashboard.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
  const res = await get(dashboard.url + '/')
  expect(res.status).toBe(200)
  expect(res.headers['content-type']).toContain('text/html')
  expect(res.body).toContain('<!doctype html>')
})

test('GET /model returns the dashboard payload as JSON, reflecting the journal', async () => {
  const journalPath = journalWith([
    '{"ts":1,"type":"run_start","data":{"runId":"run-9","name":"demo","goal":"g"}}',
    '{"ts":2,"type":"verified","data":{"reason":"all verifiers passed","costUsd":0.4}}',
  ])
  dashboard = await startDashboardServer({ journalPath })
  const res = await get(dashboard.url + '/model')
  expect(res.status).toBe(200)
  expect(res.headers['content-type']).toContain('application/json')
  const payload = JSON.parse(res.body)
  expect(payload.runId).toBe('run-9')
  expect(payload.status).toBe('verified')
  expect(payload.layout).toEqual([])
})

test('GET /model on a run directory with no journal yet returns an empty, running payload', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lr-dash-'))
  dashboard = await startDashboardServer({ journalPath: join(dir, 'journal.jsonl') })
  const res = await get(dashboard.url + '/model')
  expect(res.status).toBe(200)
  const payload = JSON.parse(res.body)
  expect(payload).toMatchObject({ runId: 'unknown', status: 'running', nodes: [] })
})

test('GET /events replays existing journal lines as SSE frames immediately', async () => {
  const journalPath = journalWith(['{"ts":1,"type":"run_start","data":{"runId":"r","name":"n","goal":"g"}}'])
  dashboard = await startDashboardServer({ journalPath, watcher: () => ({ close() {} }) })
  const body = await new Promise<string>((resolve, reject) => {
    http.get(dashboard!.url + '/events', (res) => {
      expect(res.headers['content-type']).toContain('text/event-stream')
      let received = ''
      res.on('data', (chunk) => {
        received += chunk
        if (received.includes('\n\n')) { res.destroy(); resolve(received) }
      })
      res.on('error', () => resolve(received)) // destroy() triggers an error on some Node versions - that's fine
    }).on('error', reject)
  })
  expect(body).toContain('"type":"run_start"')
})

test('GET /events with the REAL fsWatcher does not crash the server when the journal file does not exist yet', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lr-dash-'))
  const journalPath = join(dir, 'journal.jsonl') // deliberately never written before connecting
  dashboard = await startDashboardServer({ journalPath }) // no watcher override - exercises the real fsWatcher
  await new Promise<void>((resolve, reject) => {
    http.get(dashboard!.url + '/events', (res) => {
      expect(res.statusCode).toBe(200)
      expect(res.headers['content-type']).toContain('text/event-stream')
      res.destroy() // SSE stream stays open by design - close it explicitly, don't wait for 'end'
      resolve()
    }).on('error', reject)
  })
  // Process is still alive and serving other routes - the crash the finding describes never happened.
  const health = await get(dashboard.url + '/model')
  expect(health.status).toBe(200)
})

test('GET /events with the REAL fsWatcher picks up events once the journal file appears after connecting', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lr-dash-'))
  const journalPath = join(dir, 'journal.jsonl') // does not exist at connection time
  dashboard = await startDashboardServer({ journalPath })
  const frame = await new Promise<string>((resolve, reject) => {
    http.get(dashboard!.url + '/events', (res) => {
      let received = ''
      res.on('data', (chunk) => {
        received += chunk
        if (received.includes('\n\n')) { res.destroy(); resolve(received) }
      })
      res.on('error', () => resolve(received))
      // Create the journal only after the stream is open, exercising the
      // directory-watch fallback picking up the file's appearance.
      writeFileSync(journalPath, '{"ts":1,"type":"run_start","data":{"runId":"r","name":"n","goal":"g"}}\n')
    }).on('error', reject)
  })
  expect(frame).toContain('"type":"run_start"')
})

test('an unknown route returns 404', async () => {
  const journalPath = journalWith(['{"ts":1,"type":"run_start","data":{"runId":"r","name":"n","goal":"g"}}'])
  dashboard = await startDashboardServer({ journalPath })
  const res = await get(dashboard.url + '/nope')
  expect(res.status).toBe(404)
})

test('GET /model against a journalPath that is a directory returns a clean error instead of crashing the process', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lr-dash-')) // journalPath itself IS the directory, not a file inside it
  dashboard = await startDashboardServer({ journalPath: dir })
  const res = await get(dashboard.url + '/model')
  expect(res.status).toBe(500)
  // the server is still alive and serving other routes afterwards
  const health = await get(dashboard.url + '/')
  expect(health.status).toBe(200)
})

test('GET /events against a journalPath that is a directory returns a clean response instead of crashing the process', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lr-dash-'))
  dashboard = await startDashboardServer({ journalPath: dir })
  const res = await get(dashboard.url + '/events')
  expect(res.status).toBe(500)
  // the server is still alive and serving other routes afterwards
  const health = await get(dashboard.url + '/model')
  expect(health.status).toBe(500) // same broken path - still a clean error, not a crash
})

test('the dashboard never writes to the journal file (read-only)', async () => {
  const journalPath = journalWith(['{"ts":1,"type":"run_start","data":{"runId":"r","name":"n","goal":"g"}}'])
  const before = require('node:fs').readFileSync(journalPath, 'utf8')
  dashboard = await startDashboardServer({ journalPath })
  await get(dashboard.url + '/')
  await get(dashboard.url + '/model')
  const after = require('node:fs').readFileSync(journalPath, 'utf8')
  expect(after).toBe(before)
})
