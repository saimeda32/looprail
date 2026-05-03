import { expect, test } from 'vitest'
import * as looprail from './index.js'

test('public SDK surface is complete', () => {
  for (const name of [
    'runLoop', 'contextHash', 'parseLoopfile', 'lintLoop',
    'validateGraph', 'expandPanels', 'createRegistry', 'MockAdapter',
    'JournalWriter', 'readJournal', 'loadCache', 'RailsGuard',
  ]) {
    expect(looprail).toHaveProperty(name)
  }
})
