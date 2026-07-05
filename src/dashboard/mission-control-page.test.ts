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

  const fnMatch = html.match(/function sessionCard\(session\) \{[\s\S]*?\n {2}\}/)
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
  const fnMatch = html.match(/function renderSessions\(sessions\) \{[\s\S]*?\n {2}\}/)
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
// Executes the inline script's own runCard/renderUsage functions (extracted
// verbatim from the built page, not reimplemented) against a minimal fake
// DOM/document, the same technique page.test.ts uses for renderReport. This
// proves actual runtime cost-display behavior, not just that certain
// strings appear in the source.
function makeFakeElement(tag: string) {
  return {
    tag,
    className: '',
    innerHTML: '',
    textContent: '',
    href: '',
    children: [] as unknown[],
    appendChild(child: unknown) { this.children.push(child); return child },
  }
}

function loadRunCard(): (run: unknown) => ReturnType<typeof makeFakeElement> {
  const html = buildMissionControlPage()
  const script = html.match(/<script>([\s\S]*)<\/script>/)![1]!
  const statusClassSrc = script.match(/var STATUS_CLASS = \{[\s\S]*?\};/)![0]
  const elSrc = script.match(/function el\(tag, className, text\) \{[\s\S]*?\n {2}\}\n/)![0]
  const formatTokensSrc = script.match(/function formatTokens\(n\) \{[\s\S]*?\n {2}\}\n/)![0]
  const formatDurationSrc = script.match(/function formatDuration\(ms\) \{[\s\S]*?\n {2}\}\n/)![0]
  const elapsedMsSrc = script.match(/function elapsedMs\(run\) \{[\s\S]*?\n {2}\}\n/)![0]
  const runCardSrc = script.match(/function runCard\(run\) \{[\s\S]*?\n {2}\}\n/)![0]
  const factory = new Function('document', `
    ${statusClassSrc}
    ${elSrc}
    ${formatTokensSrc}
    ${formatDurationSrc}
    ${elapsedMsSrc}
    ${runCardSrc}
    return runCard;
  `)
  const fakeDocument = { createElement: (tag: string) => makeFakeElement(tag) }
  return factory(fakeDocument) as (run: unknown) => ReturnType<typeof makeFakeElement>
}

function baseRun(overrides: Record<string, unknown>) {
  return {
    workspaceHash: 'h', runId: 'r1', name: 'demo', status: 'verified',
    agents: [], iteration: 1, tokens: 100, costUsd: 0, estimatedCostUsd: 0,
    ...overrides,
  }
}

function findCostSpan(card: ReturnType<typeof makeFakeElement>) {
  const stats = card.children.find((c) => (c as { className: string }).className === 'stats') as
    { children: { className: string, innerHTML: string }[] } | undefined
  return stats?.children.find((c) => c.innerHTML.indexOf('$') !== -1)
}

test('a run tile with costUsd 0 and a nonzero estimate shows the estimate prominently, not a flat $0.00', () => {
  const runCard = loadRunCard()
  const card = runCard(baseRun({ costUsd: 0, estimatedCostUsd: 0.42 }))
  const cost = findCostSpan(card)
  expect(cost).toBeDefined()
  expect(cost!.innerHTML).toContain('0.42')
  expect(cost!.innerHTML).toContain('est')
  expect(cost!.innerHTML).not.toBe('$<b>0.00</b>')
})

test('a run tile with a nonzero real costUsd still shows the real figure as primary', () => {
  const runCard = loadRunCard()
  const card = runCard(baseRun({ costUsd: 1.5, estimatedCostUsd: 0 }))
  const cost = findCostSpan(card)
  expect(cost!.innerHTML).toBe('$<b>1.50</b>')
})

test('a run tile with both a nonzero real costUsd and an estimate keeps the real figure primary, estimate appended', () => {
  const runCard = loadRunCard()
  const card = runCard(baseRun({ costUsd: 1.5, estimatedCostUsd: 0.3 }))
  const cost = findCostSpan(card)
  expect(cost!.innerHTML).toContain('$<b>1.50</b>')
  expect(cost!.innerHTML).toContain('~$0.30 est')
})

test('a run tile with costUsd 0 and no estimate still shows a flat $0.00 (nothing was actually spent)', () => {
  const runCard = loadRunCard()
  const card = runCard(baseRun({ costUsd: 0, estimatedCostUsd: 0 }))
  const cost = findCostSpan(card)
  expect(cost!.innerHTML).toBe('$<b>0.00</b>')
})

function loadRenderUsage() {
  const html = buildMissionControlPage()
  const script = html.match(/<script>([\s\S]*)<\/script>/)![1]!
  const formatTokensSrc = script.match(/function formatTokens\(n\) \{[\s\S]*?\n {2}\}\n/)![0]
  const formatDurationSrc = script.match(/function formatDuration\(ms\) \{[\s\S]*?\n {2}\}\n/)![0]
  const elapsedMsSrc = script.match(/function elapsedMs\(run\) \{[\s\S]*?\n {2}\}\n/)![0]
  const renderUsageSrc = script.match(/function renderUsage\(runs\) \{[\s\S]*?\n {2}\}\n/)![0]
  const factory = new Function('document', `
    ${formatTokensSrc}
    ${formatDurationSrc}
    ${elapsedMsSrc}
    ${renderUsageSrc}
    return renderUsage;
  `)
  const store: Record<string, { textContent: string }> = {
    'usage-workspaces': { textContent: '' },
    'usage-runs': { textContent: '' },
    'usage-running': { textContent: '' },
    'usage-cost': { textContent: '' },
    'usage-tokens': { textContent: '' },
    'usage-wall': { textContent: '' },
  }
  const fakeDocument = { getElementById: (id: string) => store[id] }
  const renderUsage = factory(fakeDocument) as (runs: unknown[]) => void
  return { renderUsage, store }
}

test('the aggregate cost total combines real and estimated spend across every run into one figure', () => {
  const { renderUsage, store } = loadRenderUsage()
  // Unlike the per-tile figure (which keeps real vs estimated visually
  // distinct), the top-line aggregate answers "how much have I actually
  // spent across everything" - a real-cost run and an estimate-only run
  // must both count toward that one number, not be conflated away by a
  // real-first precedence that would under-report the true total.
  renderUsage([
    baseRun({ costUsd: 0.5, estimatedCostUsd: 0 }),
    baseRun({ costUsd: 0, estimatedCostUsd: 0.42 }),
  ])
  expect(store['usage-cost'].textContent).toBe('$0.92')
})

test('the aggregate cost total sums multiple estimate-only runs correctly', () => {
  const { renderUsage, store } = loadRenderUsage()
  renderUsage([
    baseRun({ costUsd: 0, estimatedCostUsd: 0.1 }),
    baseRun({ costUsd: 0, estimatedCostUsd: 0.2 }),
  ])
  expect(store['usage-cost'].textContent).toBe('$0.30')
})

test('the aggregate cost total stays a flat $0.00 when no run has any real or estimated spend', () => {
  const { renderUsage, store } = loadRenderUsage()
  renderUsage([baseRun({ costUsd: 0, estimatedCostUsd: 0 })])
  expect(store['usage-cost'].textContent).toBe('$0.00')
})

test('run tiles render a one-line reason for halted/canceled runs, distinctly classed, reusing run.reason verbatim', () => {
  const html = buildMissionControlPage()
  const fnMatch = html.match(/function runCard\(run\) \{[\s\S]*?\n {2}\}/)
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


// tickWall is the client-side live-tick handler wired to a real
// setInterval so running-run tiles and the aggregate strip keep advancing
// once per second between SSE frames, without any fetch/SSE round trip.
// Extracts the actual runtime functions (RANGES/filterByRange/elapsedMs/
// formatDuration/tickWall) verbatim from the built page, the same
// new-Function + fake-DOM technique used above for runCard/renderUsage,
// and exposes a setLastRuns hook so the test can populate the module's
// private lastRuns closure variable the way renderRuns normally would.
function loadTickWall() {
  const html = buildMissionControlPage()
  const script = html.match(/<script>([\s\S]*)<\/script>/)![1]!
  const rangesSrc = script.match(/var RANGES = \[[\s\S]*?\];/)![0]
  const selectedRangeSrc = "var selectedRange = 'all';"
  const lastRunsSrc = 'var lastRuns = [];'
  const filterByRangeSrc = script.match(/function filterByRange\(runs\) \{[\s\S]*?\n {2}\}\n/)![0]
  const formatDurationSrc = script.match(/function formatDuration\(ms\) \{[\s\S]*?\n {2}\}\n/)![0]
  const elapsedMsSrc = script.match(/function elapsedMs\(run\) \{[\s\S]*?\n {2}\}\n/)![0]
  const tickWallSrc = script.match(/function tickWall\(\) \{[\s\S]*?\n {2}\}\n/)![0]
  const factory = new Function('document', `
    ${rangesSrc}
    ${selectedRangeSrc}
    ${lastRunsSrc}
    ${filterByRangeSrc}
    ${formatDurationSrc}
    ${elapsedMsSrc}
    ${tickWallSrc}
    return {
      tickWall: tickWall,
      setLastRuns: function (runs) { lastRuns = runs; },
    };
  `)
  return factory as unknown as (document: unknown) => {
    tickWall: () => void
    setLastRuns: (runs: unknown[]) => void
  }
}

test('the inline script wires a real setInterval to tick the wall-time readings once per second', () => {
  const html = buildMissionControlPage()
  const script = html.match(/<script>([\s\S]*)<\/script>/)![1]!
  expect(script).toMatch(/setInterval\(tickWall,\s*1000\)/)
})

test('tickWall updates a running run tile\'s wall-time span from lastRuns, without a fetch call', () => {
  const wallSpan = { className: '', innerHTML: '' }
  const store: Record<string, unknown> = {
    'wall-h-r1': wallSpan,
    'usage-wall': { textContent: '' },
  }
  const fakeDocument = { getElementById: (id: string) => store[id] }
  const factory = loadTickWall()
  const { tickWall, setLastRuns } = factory(fakeDocument)
  const startedAt = Date.now() - 5000
  setLastRuns([baseRun({ workspaceHash: 'h', runId: 'r1', status: 'running', startedAt, maxWallMinutes: 45 })])
  tickWall()
  expect(wallSpan.innerHTML).toContain('/ 45m')
  expect(wallSpan.className).toBe('num')
})

test('tickWall flags an over-budget running run via the wall-over class', () => {
  const wallSpan = { className: '', innerHTML: '' }
  const store: Record<string, unknown> = {
    'wall-h-r1': wallSpan,
    'usage-wall': { textContent: '' },
  }
  const fakeDocument = { getElementById: (id: string) => store[id] }
  const factory = loadTickWall()
  const { tickWall, setLastRuns } = factory(fakeDocument)
  const startedAt = Date.now() - 46 * 60 * 1000
  setLastRuns([baseRun({ workspaceHash: 'h', runId: 'r1', status: 'running', startedAt, maxWallMinutes: 45 })])
  tickWall()
  expect(wallSpan.className).toBe('num wall-over')
})

test('tickWall never advances a finished run\'s wall-time reading (fixed lastEventAt - startedAt)', () => {
  const wallSpan = { className: '', innerHTML: '<b>should not change</b>' }
  const store: Record<string, unknown> = {
    'wall-h-r1': wallSpan,
    'usage-wall': { textContent: '' },
  }
  const fakeDocument = { getElementById: (id: string) => store[id] }
  const factory = loadTickWall()
  const { tickWall, setLastRuns } = factory(fakeDocument)
  setLastRuns([baseRun({ workspaceHash: 'h', runId: 'r1', status: 'verified', startedAt: 1000, lastEventAt: 61000 })])
  tickWall()
  // status !== 'running', so tickWall must not touch the per-tile span at all
  expect(wallSpan.innerHTML).toBe('<b>should not change</b>')
})

test('tickWall recomputes the aggregate usage-wall total across lastRuns without a fetch', () => {
  const store: Record<string, unknown> = {
    'usage-wall': { textContent: '' },
  }
  const fakeDocument = { getElementById: (id: string) => store[id] }
  const factory = loadTickWall()
  const { tickWall, setLastRuns } = factory(fakeDocument)
  setLastRuns([
    baseRun({ workspaceHash: 'h', runId: 'r1', status: 'verified', startedAt: 1000, lastEventAt: 61000 }),
    baseRun({ workspaceHash: 'h', runId: 'r2', status: 'verified', startedAt: 1000, lastEventAt: 61000 }),
  ])
  tickWall()
  expect((store['usage-wall'] as { textContent: string }).textContent).toBe('2m 0s')
})
