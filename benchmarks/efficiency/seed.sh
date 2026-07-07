#!/usr/bin/env bash
# Seeds one benchmark workspace into $1: a small JS project whose slugify()
# is naively wrong against a strict edge-case suite. The edge cases (diacritic
# folding, camelCase splitting, apostrophe deletion vs separator collapsing)
# are the kind a first attempt commonly gets partially wrong - which is what
# makes the loop iterate, and iteration is the scenario the A/B measures.
set -euo pipefail
ws="$1"
mkdir -p "$ws/src" "$ws/test"

cat > "$ws/package.json" <<'EOF'
{
  "name": "efficiency-ab-workspace",
  "private": true,
  "scripts": { "test": "node --test" }
}
EOF

cat > "$ws/src/slugify.js" <<'EOF'
// Known-buggy starting point: lowercases and swaps spaces for dashes, and
// nothing else. The test suite is the real spec.
module.exports = function slugify(input) {
  return String(input).toLowerCase().replace(/ /g, '-')
}
EOF

cat > "$ws/test/slugify.test.js" <<'EOF'
const { test } = require('node:test')
const assert = require('node:assert')
const slugify = require('../src/slugify.js')

test('lowercases and dashes spaces', () => {
  assert.strictEqual(slugify('Hello World'), 'hello-world')
})
test('collapses runs of separators into one dash', () => {
  assert.strictEqual(slugify('a  b -- c__d'), 'a-b-c-d')
})
test('trims leading/trailing separators', () => {
  assert.strictEqual(slugify('  -hello-  '), 'hello')
})
test('folds common diacritics to ascii', () => {
  assert.strictEqual(slugify('Crème Brûlée'), 'creme-brulee')
})
test('splits camelCase words', () => {
  assert.strictEqual(slugify('helloWorld FTW'), 'hello-world-ftw')
})
test('deletes apostrophes instead of dashing them', () => {
  assert.strictEqual(slugify("it's o'clock"), 'its-oclock')
})
test('drops all other punctuation as separators', () => {
  assert.strictEqual(slugify('rock & roll, baby!'), 'rock-roll-baby')
})
test('empty and non-string-safe', () => {
  assert.strictEqual(slugify(''), '')
  assert.strictEqual(slugify(42), '42')
})
EOF
