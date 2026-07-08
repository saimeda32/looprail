#!/usr/bin/env bash
# EFF-7: engine-version A/B of looprail's efficiency work, in real dollars.
#
#   ./run.sh [--yes]
#
# Runs the SAME two-branch loopfile on the same seeded task twice:
#   old: looprail@0.5.0  (last engine before lineage-scoped feedback,
#        the within-run cache, and incremental executors)
#   new: this checkout's build (or looprail@latest if dist/ is absent)
# then compares status, iterations, real cost, and agent invocations from
# each run's own journal. THIS SPENDS REAL MONEY via your installed agent
# CLIs (bounded by the loopfile's max_cost_usd: 6 per engine, so <= ~12 USD
# worst case). The delta only appears when the run actually iterates - a
# first-try pass costs the same on both engines, and that's an honest result.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../.." && pwd)"

if [[ "${1:-}" != "--yes" ]]; then
  echo "This benchmark invokes real agent CLIs twice (old + new engine) and"
  echo "spends real money - bounded at ~6 USD per engine by the loopfile rails."
  read -r -p "Continue? [y/N] " answer
  [[ "$answer" == "y" || "$answer" == "Y" ]] || { echo "aborted - nothing was spent."; exit 1; }
fi

new_cmd="npx -y looprail@latest"
if [[ -f "$repo/dist/cli/index.js" ]]; then
  new_cmd="node $repo/dist/cli/index.js"
fi

# The old engine must be invoked as `node <real entry file>`, NOT via npx:
# every release before 0.8.1 had an is-main guard that silently no-ops when
# argv[1] is a bin symlink (which is exactly how npx runs it). Installing it
# into a scratch prefix and running its entry file directly sidesteps the
# bug the same way this repo's own dev invocations always did.
old_prefix="$(mktemp -d "${TMPDIR:-/tmp}/lr-eff-oldpkg-XXXXXX")"
(cd "$old_prefix" && npm install --silent --no-audit --no-fund looprail@0.5.0 >/dev/null)
# pwd -P: macOS mktemp paths live under /var/folders, itself a symlink to
# /private/var/folders - the same unresolved-symlink mismatch that breaks
# the old guard. Hand it the fully resolved path.
old_entry="$(cd "$old_prefix/node_modules/looprail/dist/cli" && pwd -P)/index.js"
old_cmd="node $old_entry"

run_one() { # $1 = label, $2 = looprail command
  local label="$1" cmd="$2"
  local ws; ws="$(mktemp -d "${TMPDIR:-/tmp}/lr-eff-$label-XXXXXX")"
  bash "$here/seed.sh" "$ws"
  cp "$here/looprail.yaml" "$ws/looprail.yaml"
  echo "== [$label] $cmd  (workspace: $ws)" >&2
  # --json prints the machine summary as the last stdout line on both engines
  local out; out="$( (cd "$ws" && $cmd run --json) | tail -1 )" || true
  local journal; journal="$(node -e "console.log(JSON.parse(process.argv[1]).journal ?? '')" "$out" 2>/dev/null || true)"
  # Billed agent invocations: node_end events that actually cost something
  # (real costUsd, or estimatedCostUsd for CLIs that never report dollars).
  # A cache-served node journals node_end with BOTH zeroed, and an agent-less
  # tester is zero on both engines equally - so this counts exactly the
  # calls that spent money, which is the thing the A/B prices.
  local billed=0
  if [[ -n "$journal" && -f "$journal" ]]; then
    billed="$(node -e '
      const lines = require("fs").readFileSync(process.argv[1], "utf8").trim().split("\n")
      let n = 0
      for (const line of lines) {
        const e = JSON.parse(line)
        if (e.type === "node_end" && ((e.data.costUsd ?? 0) > 0 || (e.data.estimatedCostUsd ?? 0) > 0)) n++
      }
      console.log(n)
    ' "$journal")"
  fi
  node -e '
    const s = JSON.parse(process.argv[1])
    console.log([process.argv[2], s.status, s.iterations, s.costUsd, process.argv[3]].join("\t"))
  ' "$out" "$label" "$billed"
}

echo ""
echo "engine	status	iters	costUsd	billed-agent-invocations"
old_row="$(run_one old "$old_cmd")"
new_row="$(run_one new "$new_cmd")"
echo "$old_row"
echo "$new_row"
echo ""
echo "Reading the result: when the run iterated, the OLD engine re-billed the"
echo "independent docs branch every iteration (global feedback changed every"
echo "prompt); the NEW engine serves it from the within-run cache, so its"
echo "billed invocations and costUsd should be lower for the same outcome."
echo "Each workspace's journal.jsonl is the full evidence trail."
