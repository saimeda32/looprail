# How looprail compares

Honest comparison, fact-checked against each project's public docs on
**2026-07-08** (star counts and licenses as shown on GitHub that day).
Feature matrices rot - if something below is stale or wrong, a PR
correcting it is welcome. Every project is linked so you can check.

## The short version

The "verified done" space has real, good tools in it, and most own one
strong idea: [zeroshot](https://github.com/covibes/zeroshot) pioneered
blind validation, [agentops](https://github.com/boshu2/agentops) the
in-repo hash-chained verdict ledger,
[loki-mode](https://github.com/asklokesh/loki-mode) graded receipts.
looprail ships those ideas in one engine, adds rails the others don't have
(scope allowlists, dependency existence checks, hard spend ceilings), and
stays vendor-neutral - which matters because the strongest verification
primitive is a critic on a *different provider* than the worker, something
no single vendor's orchestration can offer about itself.

## Capability matrix

| Capability | [looprail](https://github.com/saimeda32/looprail) (MIT) | [zeroshot](https://github.com/covibes/zeroshot) (1.6k★, MIT) | [agentops](https://github.com/boshu2/agentops) (405★, Apache-2.0) | [loki-mode](https://github.com/asklokesh/loki-mode) (~1k★, BUSL-1.1) | [conductor](https://github.com/microsoft/conductor) (302★, MIT) | vendor-native (Claude Agent Teams, Codex delegation) |
| --- | --- | --- | --- | --- | --- | --- |
| Mix agent vendors in one loop | ✅ 8 adapters + rate-limit failover chains | ✅ 4 CLIs | ✅ 5 CLIs | ✅ 4 active (Gemini deprecated) | partial (Copilot SDK, Claude SDK experimental, OpenAI-compatible) | ❌ one vendor by definition |
| Real shell tests gate "done" | ✅ tester nodes | ✅ validator evidence w/ exit codes | partial (a test is one validation option, not mandatory) | ✅ blocks on red tests | ❌ no built-in verify-until-pass primitive (script/wait steps can hand-build checks) | partial |
| Cross-model critic, self-grading linted against | ✅ | ✅ | ✅ | ✅ | ❌ | ❌ structurally |
| Critic reviews the diff, not the agent's story | ✅ `blind: true` | ✅ blind validation (its headline idea) | close: fresh-context judges | ✅ blind 3-reviewer council w/ severity blocking + Devil's Advocate | ❌ | ❌ |
| Test-tamper guard | ✅ `protect:` hashes test files; repeat offense halts | ❌ | ❌ | ✅ different flavor: `proof verify` re-runs the recorded diff + test-mutation and mock-integrity gates | ❌ | ❌ |
| Scope allowlist on the diff | ✅ `scope:` | ❌ | ❌ | ❌ | ❌ | ❌ |
| Dependency existence check (anti-slopsquatting) | ✅ `verify_deps:` | ❌ | ❌ | partial: a "dependency audit" is mentioned, existence-checking unclear | ❌ | ❌ |
| Graded pass with named gaps | ✅ `GAPS:` | ❌ binary accept/reject | ❌ | ✅ VERIFIED / VERIFIED WITH GAPS / NOT VERIFIED (its headline idea) | ❌ | ❌ |
| Tamper-evident verdict ledger in the repo | ✅ hash-chained + `ledger --verify` | ❌ (SQLite state ledger, not cryptographic) | ✅ hash-chained in `.agents/` (its headline idea) | receipts computed from recorded facts | ❌ | ❌ |
| Hard dollar rails | ✅ real + estimated spend, checked before each node; `spend` report | partial: model ceilings only | ❌ | partial: passes `--max-budget-usd`/model-tier ceilings, no hard veto | ❌ | rollout token budgets (Codex) |
| Human gates in the loop | ✅ park-and-resume, free-text feedback drives replan | ❌ auto-merges on validator consensus | ❌ | ❌ (final deploy is human-run, no in-loop gate) | ✅ in-browser gates | ❌ |
| Fresh-context iterations (Ralph pattern) | ✅ `context: fresh` | ❌ | ❌ | ❌ | ❌ | ❌ |
| Spec/PRD intake with requirement-coverage review | ✅ `init --from-spec` | issue intake (GitHub/GitLab/Jira/ADO) | ❌ | ✅ spec to code+CI (human runs the deploy) | ❌ | ❌ |
| Resume without re-billing finished work | ✅ | resume via SQLite ledger (crash recovery) | ❌ | ❌ | ❌ | ❌ |
| Live dashboard | ✅ | ❌ (logs -f; TUI not in current release) | ❌ (no hosted control plane by design) | ❌ | ✅ live DAG | varies |
| Queue / MCP server mode | ✅ / ✅ | ❌ / ❌ (integrates MCP tools, isn't a server) | ❌ / ❌ | ❌ / ❌ | ❌ / ❌ | varies |
| Try it with zero setup | ✅ `npx looprail demo` (offline, no keys) | isolation optional (none/worktree/Docker) | per-repo install | BUSL license gate for commercial use | Copilot SDK setup | vendor account |

## What the others do better (credit where due)

- **zeroshot** scales validator count to task risk automatically
  (TRIVIAL/SIMPLE/STANDARD/CRITICAL - critical work gets five validators
  including security and adversarial-execution ones); looprail's panel
  size is author-chosen. It also takes work straight from
  GitHub/GitLab/Jira/Azure DevOps issue URLs.
- **loki-mode**'s verification arsenal is genuinely deep: test-mutation
  detection, mock-integrity detection, and a `proof verify` that re-runs
  the recorded diff from its base SHA. Its graded receipts ("the headline
  is computed only from the facts") are the idea looprail's `GAPS:`
  gratefully builds on.
- **agentops** made the in-repo, hash-chained verdict ledger the whole
  product, with zero hosted anything - a sharper single-purpose take than
  looprail's `ledger: true`.
- **gastown** ([16.9k★](https://github.com/gastownhall/gastown)) is a
  different category - a workspace manager for *fleets* of agents (10
  agent presets) with git-backed institutional memory and a Bors-style
  merge queue. Verification happens there too, but at the merge queue
  (tests must pass, failures get bisected) rather than as a per-change
  verify-until-pass loop. If you run ten agents on one repo all day, you
  probably want it; the two compose.
- **conductor** keeps orchestration decisions fully deterministic (Jinja2
  routing, "no tokens spent deciding what runs next"), which is the right
  call for repeatable enterprise workflows, and its in-browser human gates
  are polished.
- **Vendor-native orchestration** (Anthropic's experimental Agent Teams,
  Codex's delegation with rollout token budgets) will always integrate
  tighter with its own agent than any wrapper can - if you're
  single-vendor and trust self-review, it's fewer moving parts.

## The one thing a vendor can't ship

A model reviewing its own vendor's output shares its blind spots - the
self-preference and self-correction research is unambiguous. Independent
verification requires a second provider by construction, which makes
vendor-neutrality not a convenience feature but the load-bearing wall.
That's the bet looprail is built on.
