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
  expect(html).not.toMatch(/https?:\/\//i)
  expect(html).not.toMatch(/<link\b/i)          // no external stylesheet/font
  expect(html).not.toMatch(/<script\s+src=/i)   // no external script (only inline <script>)
  expect(html).not.toMatch(/cdn\./i)
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
