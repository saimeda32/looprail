import { expect, test } from 'vitest'
import { buildMissionControlPage } from './mission-control-page.js'

test('the page is a complete, self-contained HTML document', () => {
  const html = buildMissionControlPage()
  expect(html).toMatch(/^<!doctype html>/i)
  expect(html).toContain('<style>')
  expect(html).toContain('<script>')
  expect(html).toContain('</html>')
})

test('nothing in the page reaches out to an external host', () => {
  const html = buildMissionControlPage()
  expect(html).not.toMatch(/<link\b/i)
  expect(html).not.toMatch(/<script\s+src=/i)
  expect(html).not.toMatch(/fetch\(\s*['"]https?:/i)
  expect(html).not.toMatch(/new\s+(XMLHttpRequest|WebSocket|EventSource)\(\s*['"]https?:/i)
  expect(html).not.toMatch(/cdn\./i)
})

test("the inline client wires EventSource('/events') and fetch('/api/runs')", () => {
  const html = buildMissionControlPage()
  expect(html).toContain(`new EventSource('/events')`)
  expect(html).toContain(`fetch('/api/runs')`)
})

test('the page renders an empty-state container and a click-through card grid', () => {
  const html = buildMissionControlPage()
  expect(html).toContain('id="empty-state"')
  expect(html).toContain('id="grid"')
  expect(html).toContain("'/run/' + run.workspaceHash")
})

test('the page reuses the exact design tokens defined on :root in page.ts', () => {
  const html = buildMissionControlPage()
  const tokens = [
    '--void: #14120f', '--panel: #1e1b17', '--panel-raised: #262219',
    '--line: #322d26', '--line-bright: #453f34', '--ink: #ede6d9',
    '--ink-dim: #8c8375', '--ink-faint: #5c564a', '--signal: #e8c468',
    '--signal-dim: #7a6636', '--pass: #7fa66b', '--fail: #c4574a', '--warn: #b8863d',
  ]
  for (const token of tokens) expect(html).toContain(token)
})

test('no old-palette hex codes from the previous dashboard leak into the page', () => {
  const html = buildMissionControlPage()
  const oldHexes = [
    '#0f1115', '#161a20', '#e8c547', '#123a1e', '#4fd07a', '#3a1414',
    '#f06868', '#24272e', '#3a3f48', '#9096a1', '#e6e8eb', '#c7cbd1',
  ]
  for (const hex of oldHexes) expect(html).not.toContain(hex)
})

test('session cards are plain, non-clickable divs distinct from the run-card/status-pill treatment', () => {
  const html = buildMissionControlPage()
  expect(html).toContain("el('div', 'session-card')")
  expect(html).not.toMatch(/el\('a',\s*'session-card'/)
  expect(html).toContain('session-badge')

  const fnMatch = html.match(/function sessionCard\(session\) \{[\s\S]*?\n  \}/)
  expect(fnMatch).not.toBeNull()
  const body = fnMatch![0]
  expect(body).not.toContain('.href')
  expect(body).not.toContain('status-pill')
  expect(body).not.toContain("STATUS_CLASS")
})

test('sessions render in a visually separate, secondary section from the run grid', () => {
  const html = buildMissionControlPage()
  expect(html).toContain('id="sessions-section"')
  expect(html).toContain('id="sessions-grid"')
  expect(html).toContain('Recent Claude Code activity')
})

test('the client renders a combined runs+sessions payload from both fetch and the SSE stream', () => {
  const html = buildMissionControlPage()
  expect(html).toContain('function renderAll(data)')
  expect(html).toContain('renderRuns(data.runs')
  expect(html).toContain('renderSessions(data.sessions')
  expect(html).toContain('.then(renderAll)')
  expect(html).toContain('renderAll(JSON.parse(e.data))')
})

test('an empty sessions array hides the sessions section instead of erroring', () => {
  const html = buildMissionControlPage()
  const fnMatch = html.match(/function renderSessions\(sessions\) \{[\s\S]*?\n  \}/)
  expect(fnMatch).not.toBeNull()
  const body = fnMatch![0]
  expect(body).toContain('sessions.length === 0')
  expect(body).toContain("style.display = 'none'")
})

test('the inline script is ES5-only: no arrow functions, const, or let', () => {
  const html = buildMissionControlPage()
  const scriptMatch = html.match(/<script>([\s\S]*)<\/script>/)
  expect(scriptMatch).not.toBeNull()
  const script = scriptMatch![1]
  expect(script).not.toMatch(/=>/)
  expect(script).not.toMatch(/\bconst\s/)
  expect(script).not.toMatch(/\blet\s/)
})

// Run tiles previously showed only the bare status word ("halted") with
// no way to tell why without opening the run. A halted/canceled run's
// tile must now also render a truncated one-line reason string (reused
// verbatim from run.reason, threaded through from RunListEntry), distinct
// from the goal/workspace lines via its own class, and it must be
// skipped entirely for a run with no reason (e.g. running/verified).
test('run tiles render a one-line reason for halted/canceled runs, distinctly classed, reusing run.reason verbatim', () => {
  const html = buildMissionControlPage()
  const fnMatch = html.match(/function runCard\(run\) \{[\s\S]*?\n  \}/)
  expect(fnMatch).not.toBeNull()
  const body = fnMatch![0]
  expect(body).toMatch(/run\.status === 'halted'/)
  expect(body).toMatch(/run\.status === 'canceled'/)
  expect(body).toContain("'reason reason-' + run.status")
  expect(body).toContain('run.reason')

  const ruleMatch = html.match(/\.run-card \.reason\s*\{([^}]*)\}/)
  expect(ruleMatch).not.toBeNull()
  expect(ruleMatch![1]).toMatch(/overflow:\s*hidden/)
  expect(ruleMatch![1]).toMatch(/white-space:\s*nowrap/)
  expect(html).toContain('.reason.reason-halted')
  expect(html).toContain('.reason.reason-canceled')
})

