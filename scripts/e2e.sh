#!/usr/bin/env bash
# Final gate for Plan 2: build the package, run the full suite, then drive a
# real loop through the BUILT CLI using the offline mock adapter.
set -euo pipefail
cd "$(dirname "$0")/.."

npm run build
npm test

# built binary answers --help and names every command
node dist/cli/index.js --help | grep -q 'run \[options\] \[file\]'
node dist/cli/index.js --help | grep -q 'doctor'

# example must lint clean through the built CLI
node dist/cli/index.js lint examples/mock-demo/looprail.yaml

# full run in a scratch dir: exit 0 = verified
tmp=$(mktemp -d)
cp examples/mock-demo/looprail.yaml "$tmp/looprail.yaml"
node dist/cli/index.js run --cwd "$tmp"
node dist/cli/index.js status --cwd "$tmp"
node dist/cli/index.js replay --cwd "$tmp" --json

echo "e2e OK"
