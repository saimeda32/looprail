import { describe, expect, test } from 'vitest'
import { renderTemplateList, templatesAction } from './templates-cmd.js'
import { TEMPLATES } from './templates.js'

describe('renderTemplateList', () => {
  test('lists every built-in template with its description', () => {
    const text = renderTemplateList().join('\n')
    for (const [name, t] of Object.entries(TEMPLATES)) {
      expect(text).toContain(name)
      expect(text).toContain(t.description)
    }
  })

  test('names each template’s agent roles and marks the reviewer', () => {
    const text = renderTemplateList().join('\n')
    // fix-tests has a worker and a reviewer-kind checker
    expect(text).toMatch(/worker/)
    expect(text).toMatch(/reviewer/)
  })

  test('points the reader at how to scaffold one', () => {
    const text = renderTemplateList().join('\n')
    expect(text).toContain('looprail init --template')
  })
})

describe('templatesAction', () => {
  test('prints the list and exits 0', () => {
    const lines: string[] = []
    const code = templatesAction({}, { io: { out: (l) => lines.push(l) } })
    expect(code).toBe(0)
    expect(lines.join('\n')).toContain('fix-tests')
  })

  test('--json emits a machine-readable catalog', () => {
    const lines: string[] = []
    const code = templatesAction({ json: true }, { io: { out: (l) => lines.push(l) } })
    expect(code).toBe(0)
    const catalog = JSON.parse(lines.join('\n'))
    const fixTests = catalog.find((t: { name: string }) => t.name === 'fix-tests')
    expect(fixTests.description).toBe(TEMPLATES['fix-tests'].description)
    expect(fixTests.agents.some((a: { reviewer: boolean }) => a.reviewer)).toBe(true)
  })
})
