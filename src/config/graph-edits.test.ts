import { expect, test } from 'vitest'
import {
  applyGraphEdits, parseGraphEditsFragment, parseGraphFragment, serializeGraphFragment,
  type GraphFragment,
} from './loopfile.js'

const BASE: GraphFragment = {
  nodes: [
    { id: 'build', role: 'executor', agent: 'worker', prompt: 'Implement the feature.' },
    { id: 'check', role: 'critic', agent: 'checker', of: 'build', after: ['build'] },
  ],
  agents: { worker: { adapter: 'claude-code' }, checker: { adapter: 'claude-code', model: 'haiku' } },
}

test('parseGraphEditsFragment returns null for a plain full-graph reply (no top-level edits key)', () => {
  const text = 'graph:\n  build: { role: executor, agent: worker }\n'
  expect(parseGraphEditsFragment(text)).toBeNull()
})

test('parseGraphEditsFragment parses a compact edits block', () => {
  const text = `
edits:
  - node: build
    set: { prompt: "Implement the feature AND add a regression test." }
`
  const parsed = parseGraphEditsFragment(text)
  expect(parsed).toEqual({ edits: [{ node: 'build', set: { prompt: 'Implement the feature AND add a regression test.' } }] })
})

test('parseGraphEditsFragment strips a stray code fence, mirroring parseGraphFragment', () => {
  const text = '```yaml\nedits:\n  - node: build\n    set: { agent: worker-2 }\n```'
  const parsed = parseGraphEditsFragment(text)
  expect(parsed?.edits).toEqual([{ node: 'build', set: { agent: 'worker-2' } }])
})

test('parseGraphEditsFragment rejects a reply that mixes edits and a full graph', () => {
  const text = 'edits:\n  - node: build\n    set: { agent: x }\ngraph:\n  build: { role: executor }\n'
  expect(() => parseGraphEditsFragment(text)).toThrow(/cannot contain both/)
})

test('applyGraphEdits changes exactly the targeted field on the targeted node, leaving every other node byte-identical', () => {
  const result = applyGraphEdits(BASE, { edits: [{ node: 'build', set: { agent: 'worker-2' } }] })
  const build = result.nodes.find((n) => n.id === 'build')!
  const check = result.nodes.find((n) => n.id === 'check')!
  expect(build.agent).toBe('worker-2')
  expect(build.prompt).toBe('Implement the feature.') // untouched field survives
  expect(check).toEqual(BASE.nodes[1]) // completely untouched node
})

test('applyGraphEdits can add a brand-new node when "set" includes a role', () => {
  const result = applyGraphEdits(BASE, {
    edits: [{ node: 'extra-test', set: { role: 'tester', run: './extra.sh', expect: 'exit 0', after: ['build'] } }],
  })
  expect(result.nodes).toHaveLength(3)
  const extra = result.nodes.find((n) => n.id === 'extra-test')!
  expect(extra).toMatchObject({ role: 'tester', run: './extra.sh', expect: 'exit 0', after: ['build'] })
})

test('applyGraphEdits can remove a node', () => {
  const result = applyGraphEdits(BASE, { edits: [{ node: 'check', remove: true }] })
  expect(result.nodes.map((n) => n.id)).toEqual(['build'])
})

test('applyGraphEdits rejects an invented (non-NodeDef) field so it degrades to the existing format-error path', () => {
  expect(() => applyGraphEdits(BASE, {
    edits: [{ node: 'build', set: { success_criteria: 'ship it' } as any }],
  })).toThrow(/not a real NodeDef field/)
})

test('applyGraphEdits rejects a "set" on an unknown node with no role (cannot invent a new node without one)', () => {
  expect(() => applyGraphEdits(BASE, {
    edits: [{ node: 'ghost', set: { prompt: 'do something' } }],
  })).toThrow(/does not exist yet/)
})

test('applyGraphEdits rejects "remove" of an unknown node', () => {
  expect(() => applyGraphEdits(BASE, { edits: [{ node: 'ghost', remove: true }] })).toThrow(/unknown node/)
})

test('serializeGraphFragment round-trips through parseGraphFragment', () => {
  const text = serializeGraphFragment(BASE)
  const reparsed = parseGraphFragment(`graph:\n${text.split('graph:\n')[1] ?? ''}` === text ? text : text)
  // simplest correctness check: re-parsing the serialized text yields an
  // equivalent fragment (same node ids/roles/agents), not the exact same
  // key ORDER YAML happens to choose.
  const full = parseGraphFragment(text)
  expect(full.nodes.map((n) => n.id).sort()).toEqual(['build', 'check'])
  expect(full.nodes.find((n) => n.id === 'build')).toMatchObject({ role: 'executor', agent: 'worker', prompt: 'Implement the feature.' })
  expect(full.agents).toEqual(BASE.agents)
})

// --- Measured token-reduction claim -----------------------------------
//
// A stable, documented estimator (repo has no tokenizer dependency to
// reuse for arbitrary free text - see src/adapters/pricing-estimator.ts,
// which only prices ALREADY-reported split token counts from a live CLI
// response, never estimates tokens from raw text itself): OpenAI's own
// public rule of thumb is ~4 characters per token for English text, so
// charCount / 4 is used here as an output-token proxy for what a full
// re-emission vs. a compact edits block would actually cost, run over a
// REALISTIC ~20KB fixture graph representative of the real observed
// failure this feature targets (a self-planning loop asked to fix one
// flagged gap re-emitting its whole graph from byte zero).
const estimateTokens = (text: string): number => Math.ceil(text.length / 4)

function buildRealisticFixtureFragment(): GraphFragment {
  const nodes: GraphFragment['nodes'] = []
  const longPrompt = (topic: string) => (
    `You are implementing ${topic}. Read the existing module fully before making ` +
    'any change. Follow the existing code style exactly, add no new dependencies, ' +
    'and keep every unrelated file untouched. Explain your reasoning for any ' +
    'non-obvious decision in a short code comment, but do not add comments that ' +
    'merely restate what the code already says. When you are done, list every ' +
    'file you touched and why.'.repeat(30)
  )
  for (let i = 1; i <= 10; i++) {
    nodes.push({ id: `build-${i}`, role: 'executor', agent: 'worker', prompt: longPrompt(`module ${i}`) })
    nodes.push({
      id: `check-${i}`, role: 'critic', agent: 'checker', of: `build-${i}`, after: [`build-${i}`],
      prompt: `Adversarially review module ${i}'s change. Attack it; report only real, concrete flaws.`.repeat(2),
    })
  }
  return {
    nodes,
    agents: {
      worker: { adapter: 'claude-code', model: 'sonnet' },
      checker: { adapter: 'claude-code', model: 'haiku' },
    },
  }
}

test('measured claim: a compact edits block costs far fewer output tokens than a full re-emit, for a representative retry', () => {
  const fixture = buildRealisticFixtureFragment()
  const fullReEmitText = serializeGraphFragment(fixture)
  // Representative feedback from the goal: one missing agent-key rename
  // plus one missing test requirement folded into an existing node's prompt.
  const fixedFragment: GraphFragment = {
    ...fixture,
    nodes: fixture.nodes.map((n) => (
      n.id === 'build-3'
        ? { ...n, agent: 'worker-renamed', prompt: `${n.prompt} Also add a regression test covering the empty-input case.` }
        : n
    )),
    agents: { ...fixture.agents, 'worker-renamed': fixture.agents!.worker },
  }
  const fixedFullReEmitText = serializeGraphFragment(fixedFragment)
  const editsText = 'edits:\n'
    + '  - node: build-3\n'
    + `    set: { agent: worker-renamed, prompt: "${fixture.nodes.find((n) => n.id === 'build-3')!.prompt} Also add a regression test covering the empty-input case." }\n`
    + 'agents:\n'
    + '  worker-renamed: { adapter: claude-code, model: sonnet }\n'

  const fullReEmitTokens = estimateTokens(fixedFullReEmitText)
  const editsTokens = estimateTokens(editsText)

  // Realistic fixture sanity check: the full document really is on the
  // order of the ~20KB observed in the real session this targets.
  expect(fullReEmitText.length).toBeGreaterThan(15000)

  const reductionPct = Math.round((1 - editsTokens / fullReEmitTokens) * 100)
  // eslint-disable-next-line no-console
  console.log(`[graph-edits token measurement] full re-emit: ${fullReEmitTokens} tokens; edits block: ${editsTokens} tokens; ${reductionPct}% reduction`)

  expect(editsTokens).toBeLessThan(fullReEmitTokens)
  expect(reductionPct).toBeGreaterThan(80) // a targeted one-node fix must not pay for the whole ~20KB document

  // Applying the compact edits block server-side must reproduce the exact
  // same resulting graph a full re-emit would have - the whole point is
  // that content correctness is unaffected by which reply shape produced it.
  const applied = applyGraphEdits(fixture, {
    edits: [{
      node: 'build-3',
      set: {
        agent: 'worker-renamed',
        prompt: `${fixture.nodes.find((n) => n.id === 'build-3')!.prompt} Also add a regression test covering the empty-input case.`,
      },
    }],
    agents: { 'worker-renamed': fixture.agents!.worker },
  })
  expect(applied.nodes.find((n) => n.id === 'build-3')).toMatchObject(
    { agent: 'worker-renamed', prompt: fixedFragment.nodes.find((n) => n.id === 'build-3')!.prompt },
  )
  expect(applied.nodes.find((n) => n.id === 'build-7')).toEqual(fixture.nodes.find((n) => n.id === 'build-7'))
})
