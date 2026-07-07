# UI/UX audit - mission control + single-run dashboard (2026-07-06)

Method: staged every real run state (live-gated, parked, verified, halted,
canceled, stale-dead) against the v0.5.0 build, captured full-page
screenshots of both pages with 52 real runs on the board, and walked each
surface against one question: **does the page tell the human what needs
them before it tells them everything else?** Findings numbered, severity
P0 (misleads or blocks) / P1 (costs real comprehension) / P2 (polish).

## The one-sentence diagnosis

Both pages are honest databases and poor cockpits: every fact is present,
rendered at equal weight, and the three states that actually need a human
(gate waiting, parked, silently-dead) are either invisible or painted as
something they are not.

## Mission control

- **MC-1 (P0) No attention hierarchy.** 52 uniform cards in one grid. A
  run blocked LIVE on a human gate renders an ordinary `running` pill -
  indistinguishable from 40 finished runs. The page's most important fact
  is invisible.
- **MC-2 (P0) Parked painted as failure.** A parked run (gate timeout -
  resumable pause, zero lost work) shows the same orange `halted` pill and
  warn-colored reason as a genuine rail breach, with the reason truncated
  mid-word ("gate \"appr..."). The parked mechanism exists so a busy human
  doesn't read as a failure; the card undoes that.
- **MC-3 (P0) Stale-dead runs show as running.** A run whose process was
  killed without a terminal journal event shows `running` with a red
  climbing wall-time (observed: 6h41m) forever. The pid-liveness probe
  exists server-side; the card ignores it.
- **MC-4 (P1) Reasons clamp to one line, no way to read the rest.** No
  title/tooltip; ellipsis mid-word.
- **MC-5 (P1) Aggregate cost mixes real + estimated without labeling.**
  "$14.34" where most is token-derived estimate; per-card falls back to
  estimate silently too.
- **MC-6 (P1) Pure recency ordering.** No grouping (needs-you / running /
  history), no per-workspace grouping; the wall of green `verified` pills
  drowns the present.
- **MC-7 (P2) "no agents recorded"** filler on older runs - noise where
  silence would do.
- **MC-8 (P2) Sessions section** spends a third of the page on 14
  truncated-id cards with one fact each ("active 8m ago").
- **MC-9 (P2) Stat line density.** `iter 1 $1.70 21.5k tok 6m 0s / 20m`
  requires decoding; unlabeled figures change meaning by position.

## Single-run page

- **SR-1 (P0) Parked renders as triple failure.** Status pill HALTED
  (orange), the gate node drawn in the DAG's *fail red*, and the final
  report shows `0% approve (gate)` with a red confidence badge - three
  independent signals all say "failed" about a state whose entire meaning
  is "nothing failed, a human was busy."
- **SR-2 (P0) Resume is a settings form, not an action.** A parked run's
  one needed action is "resume - the gate will ask again." What renders is
  a raw Iterations/Cost/Wall/Replan/Goal input row with a dim button -
  dev-tool ergonomics at the page's most important moment.
- **SR-3 (P0) The click-here-read-there pattern survives for node detail.**
  Clicking a DAG node populates a SELECTED NODE section at the very bottom
  of the page, while the right-hand panel beside the DAG sits EMPTY on
  finished runs. Same class of failure as the old gate row (fixed for
  gates in v0.5.0, still present for node inspection).
- **SR-4 (P1) "no max set" wall gauge renders a FULL gold bar.** A full
  meter reads as "budget exhausted"; with no rail set it should read as
  absence, not fullness.
- **SR-5 (P1) The live-output tab panel is dead space on finished runs** -
  the best real estate on the page, empty exactly when the inspector
  (SR-3) needs a home.
- **SR-6 (P1) No iteration timeline.** Verdict history exists only as text
  inside the bottom detail panel; the run's shape over time (pass/fail per
  iteration) has no visual form.
- **SR-7 (P2) Report confidence badges misapplied to mechanical rows.** A
  gate park is not a "0%-confidence claim"; percent semantics belong to
  agent-reported claims only.

## Cross-cutting

- **X-1 (P1) Status vocabulary is implicit.** running / verified / halted /
  canceled are first-class; parked and stale-dead exist only as reason-text
  patterns. Canonical set (+ one color each) should be defined once and
  shared by both pages, the CLI, and the MCP surface.
- **X-2 (P2) Color-only severity on pills** (labels present, so acceptable;
  keep labels).
- **X-3 (P2) Mission control re-scans every journal on every poll** - fine
  at ~50 runs, a scaling cliff at ~1000. Not a UX fix; noted for 0.7.

## Fix order (implemented as the 0.6.0 UX wave)

1. **Status truthfulness (MC-2, MC-3, SR-1, X-1):** `parked` and `stale`
   as first-class derived statuses; own pills/colors; gate node neutral
   (signal, not fail) when parked; report row treatment.
2. **Needs-you triage (MC-1, MC-6):** pinned "Needs you" section - live
   gates and parked runs - above Running, above History.
3. **One-click resume for parked (SR-2):** primary "Resume run" button
   (gate re-asks, work cached); the override form collapses to
   "Advanced".
4. **Node inspector in the side panel (SR-3, SR-5):** selected-node detail
   renders in the tab panel beside the DAG; bottom section removed.
5. **Honest gauges + labels (SR-4, MC-5, MC-4):** empty bar when no max;
   `~` prefix and label on estimated figures; full reason on hover +
   2-line clamp.
6. **Noise pass (MC-7, MC-8, SR-7):** drop unknown-agents filler, collapse
   sessions to one summary line, restrict % badges to agent claims.
