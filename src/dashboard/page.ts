// Self-contained dashboard page: inline CSS, inline vanilla-JS client, inline
// SVG DAG rendering. No external request of any kind - see Global Constraints.
export function buildPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>looprail dashboard</title>
<style>
  :root {
    color-scheme: dark;
    --void: #14120f;
    --panel: #1e1b17;
    --panel-raised: #262219;
    --line: #322d26;
    --line-bright: #453f34;
    --ink: #ede6d9;
    --ink-dim: #8c8375;
    --ink-faint: #5c564a;
    --signal: #e8c468;
    --signal-dim: #7a6636;
    --pass: #7fa66b;
    --fail: #c4574a;
    --warn: #b8863d;
    --mono: ui-monospace, "SF Mono", "Cascadia Code", "JetBrains Mono", Menlo, Consolas, monospace;
    --sans: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  }
  * { box-sizing: border-box; }
  html, body { background: var(--void); min-height: 100%; }
  body {
    margin: 0; font: 14px/1.5 var(--sans); color: var(--ink);
    background-image:
      linear-gradient(var(--line) 1px, transparent 1px),
      linear-gradient(90deg, var(--line) 1px, transparent 1px);
    background-size: 48px 48px; background-position: -1px -1px;
    display: flex; flex-direction: column; min-height: 100vh;
  }
  a { color: inherit; }
  .wrap { max-width: 1180px; width: 100%; margin: 0 auto; padding: 24px 24px 40px; flex: 1 0 auto; }

  .site-footer {
    flex-shrink: 0; border-top: 1px solid var(--line); padding: 18px 24px;
    display: flex; align-items: center; justify-content: space-between; gap: 16px; flex-wrap: wrap;
  }
  .site-footer .brand { font-family: var(--mono); font-size: 12px; color: var(--ink-faint); }
  .site-footer nav { display: flex; gap: 20px; }
  .site-footer nav a {
    font-size: 12px; color: var(--ink-dim); text-decoration: none;
  }
  .site-footer nav a:hover { color: var(--signal); }

  .masthead {
    display: flex; align-items: baseline; justify-content: space-between; gap: 16px;
    padding-bottom: 20px; border-bottom: 1px solid var(--line); margin-bottom: 28px; flex-wrap: wrap;
  }
  .wordmark {
    font-family: var(--mono); font-size: 14px; font-weight: 600; letter-spacing: 0.02em;
    display: flex; align-items: center; gap: 9px;
  }
  .wordmark .dot { width: 7px; height: 7px; border-radius: 1px; background: var(--signal); box-shadow: 0 0 8px 1px rgba(232,196,104,0.55); animation: pulse-dot 2.4s ease-in-out infinite; }
  #back-link { font: 11px var(--mono); color: var(--ink-dim); text-decoration: none; display: none; }
  #back-link:hover { color: var(--ink); }

  .section-head { font-family: var(--sans); font-size: 12px; font-weight: 600; letter-spacing: 0.1em; text-transform: uppercase; color: var(--ink-dim); margin: 36px 0 12px; }
  .section-head:first-of-type { margin-top: 0; }

  .run-panel { border: 1px solid var(--line); border-radius: 3px; background: var(--panel); overflow: hidden; box-shadow: 0 2px 16px rgba(0,0,0,0.25); }
  .run-header { display: flex; align-items: center; justify-content: space-between; padding: 14px 18px; border-bottom: 1px solid var(--line); flex-wrap: wrap; gap: 12px; }
  .run-title { display: flex; align-items: baseline; gap: 10px; min-width: 0; }
  .run-title .name { font-size: 14px; font-weight: 600; }
  .run-title .id { font: 11px var(--mono); color: var(--ink-faint); }
  /* Prominent, full-width banner - deliberately NOT the same small dim-gray
     inline text that used to sit next to the run title, which read as
     routine metadata and was easy to miss, and looked identical whether the
     run halted from a rail breach or a user cancel. Distinct classes per
     status so a rail-limit halt (amber, matches .status-halted) and a
     deliberate user cancel (neutral gray, matches .status-canceled) are
     visually distinguishable from each other, not just from "running". */
  .reason-banner {
    display: none; align-items: flex-start; gap: 8px; padding: 10px 18px;
    font-size: 13px; line-height: 1.5; border-bottom: 1px solid var(--line);
  }
  .reason-banner .reason-label { font: 600 10.5px var(--sans); letter-spacing: 0.08em; text-transform: uppercase; flex: 0 0 auto; }
  .reason-banner.reason-parked { color: var(--signal); background: rgba(232,196,104,0.08); border-color: rgba(232,196,104,0.3); }
  .reason-banner.reason-halted { color: var(--warn); background: rgba(184,134,61,0.10); }
  .reason-banner.reason-canceled { color: var(--ink-dim); background: rgba(140,131,117,0.10); }
  .run-goal { padding: 12px 18px; border-bottom: 1px solid var(--line); font-size: 12.5px; line-height: 1.5; color: var(--ink-dim); white-space: pre-wrap; max-height: 200px; overflow: auto; }
  .run-goal:empty { display: none; }

  .status-pill {
    display: inline-flex; align-items: center; gap: 6px; font: 600 10.5px/1.4 var(--mono);
    letter-spacing: 0.08em; text-transform: uppercase; padding: 4px 9px 4px 7px; border-radius: 3px;
    border: 1px solid transparent; white-space: nowrap;
  }
  .status-pill::before { content: ''; width: 6px; height: 6px; border-radius: 1px; background: currentColor; display: inline-block; }
  .status-running { color: var(--signal); background: rgba(232,196,104,0.12); border-color: rgba(232,196,104,0.32); }
  .status-running::before { animation: pulse-dot 1.6s ease-in-out infinite; }
  .status-verified { color: var(--pass); background: rgba(127,166,107,0.12); border-color: rgba(127,166,107,0.3); }
  .status-halted { color: var(--warn); background: rgba(184,134,61,0.12); border-color: rgba(184,134,61,0.3); }
  .status-parked { color: var(--signal); background: rgba(232,196,104,0.12); border-color: rgba(232,196,104,0.32); }
  .status-canceled { color: var(--ink-dim); background: rgba(140,131,117,0.12); border-color: rgba(140,131,117,0.3); }

  .gauges { display: flex; align-items: center; gap: 26px; padding: 11px 18px; border-bottom: 1px solid var(--line); flex-wrap: wrap; }
  .gauge { display: flex; align-items: center; gap: 9px; }
  .gauge .label { font: 600 10.5px var(--sans); letter-spacing: 0.1em; text-transform: uppercase; color: var(--ink-dim); white-space: nowrap; }
  .gauge .reading { font: 12px var(--mono); font-variant-numeric: tabular-nums; color: var(--ink); white-space: nowrap; }
  .gauge .reading .of { color: var(--ink-faint); }
  /* human-wait share of wall time - informational, deliberately quieter
     than the reading it annotates */
  .gauge .wall-human { color: var(--signal-dim); font-size: 11px; }
  .meter { width: 84px; height: 5px; background: var(--line); border-radius: 2px; overflow: hidden; }
  .meter > span { display: block; height: 100%; background: var(--signal-dim); transition: width 0.5s ease; }
  .meter > span.over { background: var(--fail); }

  .run-body { display: grid; grid-template-columns: 1fr 360px; }
  @media (max-width: 800px) { .run-body { grid-template-columns: 1fr; } }
  #dag-panel { position: relative; min-width: 0; }
  #canvas-wrap { overflow: auto; border-right: 1px solid var(--line); padding: 16px; max-height: 480px; }
  @media (max-width: 800px) { #canvas-wrap { border-right: none; border-bottom: 1px solid var(--line); } }
  #dag { display: block; }
  /* A sibling OVERLAY of #canvas-wrap, not a scrolled child of it - a
     child positioned inside a scrolling box still moves with that box's
     own scroll offset even with position:sticky/float (a real bug caught
     live: the previous float:right positioned this relative to the DAG's
     full, often much wider than visible, scrollable content width, so it
     visibly drifted as the graph was panned/zoomed instead of staying put
     in the viewport's actual corner). #dag-panel (the non-scrolling
     parent) is the positioning root instead, so this never moves
     regardless of #canvas-wrap's own scroll position. */
  #dag-toolbar {
    position: absolute; top: 8px; right: 8px; z-index: 2; display: flex; align-items: center; gap: 4px;
    background: var(--panel-raised); border: 1px solid var(--line); border-radius: 3px; padding: 3px;
  }
  #dag-toolbar button {
    font: 12px var(--mono); width: 22px; height: 22px; line-height: 1; border-radius: 2px; border: 1px solid transparent;
    background: none; color: var(--ink-dim); cursor: pointer;
  }
  #dag-toolbar button:hover { color: var(--ink); border-color: var(--line-bright); }
  #dag-zoom-fit { width: auto !important; padding: 0 7px; font-size: 10.5px !important; }
  #dag-zoom-readout { font: 11px var(--mono); color: var(--ink-faint); width: 38px; text-align: center; font-variant-numeric: tabular-nums; }
  #canvas-wrap.panning { cursor: grabbing; user-select: none; }
  .node-plate { fill: var(--panel-raised); stroke: var(--line-bright); stroke-width: 1.5; cursor: pointer; }
  .node-plate.node-running { stroke: var(--signal); }
  .node-plate.node-pass, .node-plate.node-done { stroke: var(--pass); }
  .node-plate.node-fail, .node-plate.node-error { stroke: var(--fail); }
  .node-plate.node-stall { stroke: var(--warn); }
  .node-plate.node-skipped { stroke: var(--line); stroke-dasharray: 4 3; }
  .node-plate.node-interrupted { stroke: var(--ink-faint); stroke-dasharray: 4 3; }
  .node-plate.node-parked { stroke: var(--signal); stroke-dasharray: 4 3; }
  .node-ring { fill: none; stroke: var(--signal); stroke-width: 1.5; opacity: 0.9; }
  .node-stats { font: 9px var(--mono); fill: var(--ink-faint); font-variant-numeric: tabular-nums; }
  .pip-pass { fill: var(--pass); }
  .pip-fail, .pip-error { fill: var(--fail); }
  .pip-parked { fill: var(--signal); }
  .pip-other { fill: var(--line-bright); }
  .trace.edge-of { stroke-dasharray: 5 4; opacity: 0.75; }
  .node-label { fill: var(--ink); font: 12px var(--mono); pointer-events: none; }
  .node-sub { fill: var(--ink-faint); font: 8.5px var(--sans); letter-spacing: 0.05em; text-transform: uppercase; pointer-events: none; }
  .node-dot { pointer-events: none; }
  .node-dot.node-running { fill: var(--signal); animation: pulse-dot 1.6s ease-in-out infinite; }
  .node-dot.node-pass, .node-dot.node-done { fill: var(--pass); }
  .node-dot.node-fail, .node-dot.node-error { fill: var(--fail); }
  .node-dot.node-stall { fill: var(--warn); }
  .node-dot.node-pending, .node-dot.node-skipped, .node-dot.node-interrupted { fill: var(--line-bright); }
  .node-dot.node-parked { fill: var(--signal); }
  .trace { stroke: var(--line-bright); stroke-width: 1.5; fill: none; marker-end: url(#arrow); }
  .arrow-head { fill: var(--line-bright); }
  .trace.edge-live { stroke: var(--signal-dim); stroke-dasharray: 4 5; animation: flow 1.1s linear infinite; marker-end: url(#arrow-live); }
  .arrow-head-live { fill: var(--signal-dim); }
  @keyframes flow { to { stroke-dashoffset: -18; } }
  @keyframes pulse-dot { 50% { opacity: 0.35; } }

  .live-pane { display: flex; flex-direction: column; min-width: 0; }
  .tab-strip { display: flex; border-bottom: 1px solid var(--line); flex-wrap: wrap; }
  .tab { font: 11px var(--mono); padding: 9px 13px; color: var(--ink-faint); border-bottom: 2px solid transparent; cursor: pointer; display: flex; align-items: center; gap: 6px; background: none; border-top: none; border-left: none; border-right: none; }
  .tab-dot { width: 5px; height: 5px; border-radius: 1px; background: var(--ink-faint); display: inline-block; }
  .tab.active { color: var(--ink); border-bottom-color: var(--signal); }
  .tab.active .tab-dot { background: var(--signal); animation: pulse-dot 1.6s ease-in-out infinite; }
  #live-output-body { flex: 1; margin: 0; padding: 14px 16px; font: 12px/1.65 var(--mono); color: var(--ink); white-space: pre-wrap; overflow: auto; max-height: 260px; background: linear-gradient(180deg, rgba(232,196,104,0.03), transparent 40px); }
  .stream-para { margin-bottom: 10px; transition: opacity 0.3s; }
  .stream-para:last-child { margin-bottom: 0; }
  .stream-para-time { color: var(--ink-faint); font-size: 10.5px; margin-right: 8px; font-variant-numeric: tabular-nums; }
  .stream-para-text strong { color: var(--signal); font-weight: 600; }
  .cursor { display: inline-block; width: 6px; height: 13px; background: var(--signal); vertical-align: text-bottom; margin-left: 1px; animation: blink 1s steps(2, jump-none) infinite; }
  @keyframes blink { 50% { opacity: 0; } }
  .live-meta { padding: 10px 16px; border-top: 1px solid var(--line); display: flex; flex-direction: column; gap: 3px; }
  .live-meta .row { font-size: 11.5px; color: var(--ink-dim); }
  .live-meta .row b { color: var(--ink); font-weight: 500; }
  #live-output-section[style*="display: none"] + .agent-table-wrap { margin-top: 0; }

  .agent-table { border: 1px solid var(--line); border-radius: 3px; overflow: hidden; overflow-x: auto; }
  .agent-row { display: grid; grid-template-columns: 1fr 90px 110px 110px 60px 90px 90px; align-items: center; padding: 9px 16px; border-bottom: 1px solid var(--line); font-size: 12.5px; background: var(--panel); gap: 8px; }
  .agent-row:last-child { border-bottom: none; }
  .agent-row:not(.head):not(.total) { transition: background 0.15s ease; }
  .agent-row:not(.head):not(.total):hover { background: var(--panel-raised); }
  .agent-row.head { font: 600 10.5px var(--sans); letter-spacing: 0.08em; text-transform: uppercase; color: var(--ink-faint); background: var(--panel-raised); }
  .agent-row.total { font-weight: 600; background: var(--panel-raised); }
  .agent-row .num { text-align: right; font-variant-numeric: tabular-nums; }
  .agent-row .role { color: var(--ink-dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .agent-row .node-ids { white-space: normal; overflow: visible; text-overflow: clip; line-height: 1.5; }
  .agent-row .node-ids > div { overflow-wrap: anywhere; }
  @media (max-width: 640px) { .agent-row { grid-template-columns: 1fr 60px 70px; } .agent-row span:nth-child(2), .agent-row span:nth-child(3), .agent-row span:nth-child(4) { display: none; } }

  .run-controls { display: flex; gap: 8px; align-items: center; }
  .control-btn {
    font: 11px var(--mono); padding: 5px 10px; border-radius: 3px; border: 1px solid var(--line);
    background: var(--panel-raised); color: var(--ink-dim); cursor: pointer;
    transition: color 0.15s ease, border-color 0.15s ease, background 0.15s ease, transform 0.1s ease;
  }
  .control-btn:active { transform: translateY(1px); }
  .control-btn:hover { color: var(--ink); border-color: var(--line-bright); }
  .control-btn.danger:hover { color: var(--fail); border-color: rgba(196,87,74,0.4); }
  .control-btn:disabled { opacity: 0.5; cursor: default; }
  #control-error { font-size: 11.5px; color: var(--fail); }

  .feedback-row, .resume-row, .gate-row {
    display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
    padding: 10px 18px; border-bottom: 1px solid var(--line); font-size: 12px;
  }
  .feedback-row input[type="text"], .gate-row input[type="text"] {
    flex: 1; min-width: 200px; font: 12px var(--mono); background: var(--panel);
    border: 1px solid var(--line); border-radius: 3px; color: var(--ink); padding: 6px 9px;
  }
  .feedback-row input[type="text"]:focus, .resume-row input[type="number"]:focus, .gate-row input[type="text"]:focus { outline: 1px solid var(--signal-dim); border-color: var(--line-bright); }
  .resume-row label { display: flex; align-items: center; gap: 6px; color: var(--ink-dim); font: 11px var(--sans); }
  .resume-row input[type="number"] {
    width: 72px; font: 12px var(--mono); font-variant-numeric: tabular-nums; background: var(--panel);
    border: 1px solid var(--line); border-radius: 3px; color: var(--ink); padding: 5px 7px;
  }
  .resume-row .resume-goal-label { flex: 1 1 100%; align-items: stretch; }
  .resume-row { flex-direction: column; align-items: stretch; }
  .resume-primary-line { display: flex; align-items: center; gap: 10px; }
  .resume-primary {
    background: var(--signal); color: #14120f; border-color: var(--signal);
    font-weight: 700; padding: 7px 14px;
  }
  .resume-primary:hover { filter: brightness(1.1); color: #14120f; }
  .resume-hint { font-size: 11.5px; color: var(--ink-dim); }
  .resume-advanced summary { cursor: pointer; font: 11px var(--sans); color: var(--ink-faint); }
  .resume-advanced summary:hover { color: var(--ink-dim); }
  .resume-advanced .resume-fields { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-top: 8px; }
  .resume-row textarea {
    flex: 1; min-width: 200px; font: 12px var(--mono); background: var(--panel); resize: vertical;
    border: 1px solid var(--line); border-radius: 3px; color: var(--ink); padding: 6px 9px;
  }
  .resume-row textarea:focus { outline: 1px solid var(--signal-dim); border-color: var(--line-bright); }
  /* still used by the mid-node permission row (id="permission-row") */
  .gate-row { border-left: 2px solid var(--signal); }
  .gate-row .gate-label { color: var(--signal); font: 600 11px var(--sans); letter-spacing: 0.02em; }

  /* The approval bar is FIXED to the bottom of the viewport, not a row
     buried in the run panel: a waiting gate is the one moment the page
     needs a human action, and that action must be visible and clickable
     no matter where the user has scrolled (live-caught complaint: the
     approve button was off-screen and the question text nowhere near it).
     The question renders in full - scrollable, pre-wrapped, never
     ellipsis-truncated - so the human reads what they're approving right
     next to the button that approves it. */
  .gate-bar {
    position: fixed; left: 0; right: 0; bottom: 0; z-index: 60;
    background: var(--panel-raised, var(--panel)); border-top: 2px solid var(--signal);
    box-shadow: 0 -8px 24px rgba(0,0,0,0.45);
    padding: 10px 24px 12px; display: flex; flex-direction: column; gap: 8px;
    max-height: 55vh;
    animation: gate-rise 0.24s ease-out;
  }
  @keyframes gate-rise {
    from { transform: translateY(16px); opacity: 0; }
    to   { transform: translateY(0); opacity: 1; }
  }
  .gate-bar .gate-label { color: var(--signal); font: 600 12px var(--sans); letter-spacing: 0.02em; }
  .gate-bar .gate-question {
    white-space: pre-wrap; overflow-wrap: anywhere; font: 12px/1.55 var(--mono); color: var(--ink);
    background: var(--panel); border: 1px solid var(--line); border-radius: 3px;
    padding: 10px 12px; overflow-y: auto; min-height: 0; flex: 0 1 auto;
    /* its own hard cap, not only the bar's flex constraint - the scrollbar
       must engage reliably regardless of how the browser resolves the
       flex-column shrink against the bar's max-height */
    max-height: 38vh;
  }
  /* macOS hides overlay scrollbars until a scroll starts, so an overflowing
     question box gives no visual hint that more content exists below the
     fold (live-caught: "I can't scroll" when the content was scrollable all
     along, it just didn't LOOK like it). Always-visible, styled scrollbar. */
  .gate-bar .gate-question::-webkit-scrollbar { width: 10px; }
  .gate-bar .gate-question::-webkit-scrollbar-track { background: var(--panel); border-radius: 5px; }
  .gate-bar .gate-question::-webkit-scrollbar-thumb {
    background: var(--signal-dim); border-radius: 5px; border: 2px solid var(--panel);
  }
  .gate-bar .gate-question::-webkit-scrollbar-thumb:hover { background: var(--signal); }
  .gate-bar .gate-question { scrollbar-width: thin; scrollbar-color: var(--signal-dim) var(--panel); }
  .gate-bar .gate-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  /* the two decisions sit TOGETHER, approve visually primary - split-apart
     buttons with an input stretched between them read as unrelated controls */
  .gate-bar .gate-approve {
    background: var(--signal); color: #14120f; border-color: var(--signal);
    font-weight: 700;
  }
  .gate-bar .gate-approve:hover { filter: brightness(1.1); color: #14120f; }
  .gate-bar .gate-actions input[type="text"] {
    flex: 1; min-width: 200px; font: 12px var(--mono); background: var(--panel);
    border: 1px solid var(--line); border-radius: 3px; color: var(--ink); padding: 6px 9px;
  }
  .gate-bar .gate-actions input[type="text"]:focus { outline: 1px solid var(--signal-dim); border-color: var(--line-bright); }
  /* room so the fixed bar never covers the page's own bottom content */
  body.gate-open .wrap { padding-bottom: 58vh; }
  #feedback-status, #resume-status, #gate-status { font-size: 11px; color: var(--ink-faint); }
  #feedback-status.ok, #resume-status.ok, #gate-status.ok { color: var(--pass); }
  #feedback-status.err, #resume-status.err, #gate-status.err { color: var(--fail); }

  #detail-panel { white-space: pre-wrap; font: 12px/1.55 var(--mono); background: var(--panel); border: 1px solid var(--line); border-radius: 3px; color: var(--ink); padding: 14px 16px; max-height: 260px; overflow: auto; }
  /* The inspector lives BESIDE the DAG (docs/UX-AUDIT-2026-07.md SR-3/SR-5):
     clicking a node shows its detail right where the click happened, in the
     pane that previously sat empty on finished runs - never in a section
     three screens below. */
  #inspector-section { padding: 12px 14px; border-left: 1px solid var(--line); }
  #inspector-section .inspector-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; }
  #inspector-section .inspector-title { font: 600 10.5px var(--sans); letter-spacing: 0.08em; text-transform: uppercase; color: var(--ink-faint); }
  #inspector-section #detail-panel { max-height: 46vh; border: none; padding: 0; background: transparent; }
  #live-output-section + #inspector-section, #inspector-section + #live-output-section { border-top: 1px solid var(--line); }
  /* Same boxed-container treatment as #detail-panel (Selected node) - the
     report previously sat as bare text with no visual container at all. */
  #report-panel { background: var(--panel); border: 1px solid var(--line); border-radius: 3px; padding: 14px 16px; }
  /* Same boxed-container treatment as #detail-panel/#report-panel - plan
     evolution previously sat as bare text with no visual container either. */
  #plans { background: var(--panel); border: 1px solid var(--line); border-radius: 3px; padding: 14px 16px; }
  .plan-version { border-left: 2px solid var(--line-bright); padding: 4px 0 4px 12px; margin-bottom: 10px; font-size: 12px; color: var(--ink-dim); }
  .plan-version pre { white-space: pre-wrap; margin: 4px 0 0; color: var(--ink); font-family: var(--mono); max-height: 240px; overflow-y: auto; }
  .report-summary { font-size: 13px; line-height: 1.6; color: var(--ink); margin-bottom: 14px; }
  .report-source { font-size: 11px; color: var(--ink-faint); margin-left: 8px; }
  .claim-row { display: flex; align-items: baseline; gap: 10px; padding: 8px 0; border-top: 1px solid var(--line); font-size: 12.5px; }
  .claim-row:first-of-type { border-top: none; }
  .claim-confidence { font-variant-numeric: tabular-nums; font-weight: 600; width: 42px; flex: 0 0 auto; text-align: right; }
  .claim-confidence.conf-high { color: var(--pass); }
  .claim-confidence.conf-mid { color: var(--warn); }
  .claim-confidence.conf-low { color: var(--fail); }
  .claim-text { color: var(--ink); }
  .claim-reason { color: var(--ink-dim); }
  #files-touched { margin-top: 14px; font-size: 12px; color: var(--ink-dim); }
  #files-touched summary { cursor: pointer; color: var(--ink); }
  #files-touched ul { margin: 8px 0 0; padding-left: 18px; font-family: var(--mono); }
  #files-touched li { padding: 1px 0; }
  #empty-state { padding: 60px 20px; text-align: center; color: var(--ink-dim); }

  @media (prefers-reduced-motion: reduce) {
    .trace.edge-live, .status-running::before, .tab.active .tab-dot, .cursor, .node-dot.node-running, .wordmark .dot, .gate-bar { animation: none !important; }
    .meter > span, .control-btn, .agent-row { transition: none !important; }
  }
</style>
</head>
<body>
<div class="wrap">
  <div class="masthead">
    <div class="wordmark"><span class="dot"></span> LOOPRAIL <a id="back-link" href="../../../">&larr; mission control</a></div>
    <span id="status-pill" class="status-pill status-running">running</span>
  </div>

  <div id="empty-state" style="display:none">no events yet - waiting for the run to start writing its journal…</div>

  <div class="run-panel" id="run-panel">
    <div class="run-header">
      <div class="run-title">
        <span class="name" id="run-title">looprail dashboard</span>
        <span class="id" id="run-id"></span>
      </div>
      <div class="run-controls" id="run-controls" style="display:none">
        <span id="control-error"></span>
        <button class="control-btn" id="btn-pause" type="button">Pause</button>
        <button class="control-btn danger" id="btn-cancel" type="button">Cancel</button>
      </div>
    </div>
    <div id="reason-banner" class="reason-banner">
      <span class="reason-label" id="reason-label"></span>
      <span id="reason"></span>
    </div>
    <div class="run-goal" id="run-goal"></div>
    <div class="feedback-row" id="feedback-row" style="display:none">
      <input type="text" id="feedback-input" placeholder="Add a note for the next attempt…" maxlength="2000" />
      <button class="control-btn" id="btn-feedback" type="button">Send</button>
      <span id="feedback-status"></span>
    </div>
    <div class="resume-row" id="resume-row" style="display:none">
      <div class="resume-primary-line">
        <button class="control-btn resume-primary" id="btn-resume-now" type="button">&#9654; Resume run</button>
        <span class="resume-hint" id="resume-hint"></span>
        <span id="resume-status"></span>
      </div>
      <details class="resume-advanced">
        <summary>Advanced: adjust budgets or goal before resuming</summary>
        <div class="resume-fields">
          <label>Iterations <input type="number" id="resume-iterations" min="1" step="1" /></label>
          <label>Cost budget $ <input type="number" id="resume-cost" min="0" step="0.01" /></label>
          <label>Wall minutes <input type="number" id="resume-wall-minutes" min="1" step="1" /></label>
          <label>Replan limit <input type="number" id="resume-replan-limit" min="1" step="1" /></label>
          <label class="resume-goal-label">Goal <textarea id="resume-goal" rows="2"></textarea></label>
          <button class="control-btn" id="btn-resume" type="button">Resume with these limits</button>
        </div>
      </details>
    </div>
    <div class="gauges">
      <div class="gauge">
        <span class="label">Iteration</span>
        <span id="iter-label" class="reading"></span>
        <div class="meter"><span id="iter-fill" style="width:0%"></span></div>
      </div>
      <div class="gauge">
        <span class="label">Cost</span>
        <span id="cost-label" class="reading"></span>
        <div class="meter"><span id="cost-fill" style="width:0%"></span></div>
      </div>
      <div class="gauge">
        <span class="label">Tokens</span>
        <span id="tokens-label" class="reading"></span>
      </div>
      <div class="gauge">
        <span class="label">Replans</span>
        <span id="replans-label" class="reading"></span>
      </div>
      <div class="gauge">
        <span class="label" title="Total node invocations - includes planning rounds and replan attempts iteration doesn't count">Calls</span>
        <span id="calls-label" class="reading"></span>
      </div>
      <div class="gauge">
        <span class="label">Wall time</span>
        <span id="wall-label" class="reading"></span>
        <span id="wall-human" class="reading wall-human" title="Time spent waiting on YOUR gate answers - excluded from the max_wall_minutes rail, and not the agents being slow"></span>
        <div class="meter"><span id="wall-fill" style="width:0%"></span></div>
      </div>
    </div>
    <div class="run-body">
      <div id="dag-panel">
        <div id="dag-toolbar">
          <button id="dag-zoom-out" type="button" title="Zoom out">&minus;</button>
          <span id="dag-zoom-readout">100%</span>
          <button id="dag-zoom-in" type="button" title="Zoom in">&plus;</button>
          <button id="dag-zoom-fit" type="button" title="Fit graph to view">Fit</button>
        </div>
        <div id="canvas-wrap">
        <svg id="dag" width="100%" height="100%">
          <defs>
            <marker id="arrow" markerWidth="8" markerHeight="8" refX="7" refY="3" orient="auto">
              <path class="arrow-head" d="M0,0 L7,3 L0,6 Z" />
            </marker>
            <marker id="arrow-live" markerWidth="8" markerHeight="8" refX="7" refY="3" orient="auto">
              <path class="arrow-head-live" d="M0,0 L7,3 L0,6 Z" />
            </marker>
            <clipPath id="node-clip"><rect x="-5" y="-5" width="158" height="70" /></clipPath>
          </defs>
          <g id="edges"></g>
          <g id="nodes"></g>
        </svg>
        </div>
      </div>
      <div class="live-pane">
        <section id="inspector-section">
          <div class="inspector-head">
            <span class="inspector-title" id="inspector-title">Node inspector</span>
            <button class="control-btn" id="inspector-close" type="button" style="display:none" title="Back to overview">&times;</button>
          </div>
          <div id="detail-panel">click a node in the graph to inspect its output and verdict history</div>
        </section>
        <section id="live-output-section" style="display:none">
          <div id="live-tabs" class="tab-strip"></div>
          <div id="live-output-body"></div>
          <div class="gate-row" id="permission-row" style="display:none">
            <span class="gate-label" id="permission-label"></span>
            <button class="control-btn" id="btn-permission-approve" type="button">Approve</button>
            <input type="text" id="permission-reject-input" placeholder="Deny with feedback…" maxlength="2000" />
            <button class="control-btn danger" id="btn-permission-reject" type="button">Deny</button>
            <span id="permission-status"></span>
          </div>
          <div id="live-meta" class="live-meta"></div>
        </section>
      </div>
    </div>
  </div>

  <div class="section-head" id="report-head" style="display:none">Final report</div>
  <div id="report-panel" style="display:none">
    <div class="report-summary" id="report-summary"></div>
    <div id="report-claims"></div>
    <div id="files-touched-container"></div>
  </div>

  <div class="section-head">Spend by agent</div>
  <div class="agent-table" id="agent-table"></div>

  <div class="section-head" id="plans-head" style="display:none">Plan evolution</div>
  <div id="plans"></div>
</div>
<footer class="site-footer">
  <span class="brand">looprail</span>
  <nav>
    <a href="https://github.com/saimeda32/looprail" target="_blank" rel="noopener">GitHub</a>
    <a href="https://github.com/saimeda32/looprail#readme" target="_blank" rel="noopener">README</a>
    <a href="https://github.com/saimeda32/looprail/blob/main/LICENSE" target="_blank" rel="noopener">License</a>
  </nav>
</footer>
<div class="gate-bar" id="gate-bar" style="display:none">
  <span class="gate-label" id="gate-label"></span>
  <div class="gate-question" id="gate-question"></div>
  <div class="gate-actions">
    <button class="control-btn gate-approve" id="btn-gate-approve" type="button">&#10003; Approve</button>
    <button class="control-btn danger" id="btn-gate-reject" type="button">&#10007; Reject</button>
    <input type="text" id="gate-reject-input" placeholder="Why? Required to reject - your reason is sent back to the agents as feedback" maxlength="2000" />
    <span id="gate-status"></span>
  </div>
</div>
<script>
(function () {
  var STATUS_CLASS = {
    pending: 'node-pending', running: 'node-running', pass: 'node-pass', done: 'node-done',
    fail: 'node-fail', error: 'node-error', stall: 'node-stall', skipped: 'node-skipped',
    interrupted: 'node-interrupted', parked: 'node-parked',
  };
  var selected = null;
  var selectedTab = null; // nodeId of the tab the user is viewing; null = auto-follow
  // Whether the user explicitly clicked a tab to PIN it. Without this, the
  // live panel stuck to the FIRST running node and never advanced as the
  // graph progressed - "streaming text doesn't change as we move through
  // the graph" (live-caught). Unpinned, the panel auto-follows the
  // most-recently-started running node so it tracks the graph's frontier.
  var tabPinned = false;

  var dagZoom = 1;
  var DAG_ZOOM_MIN = 0.4, DAG_ZOOM_MAX = 2.5, DAG_ZOOM_STEP = 0.15;
  var dagContentW = 400, dagContentH = 200;
  var lastAutoScrollNodeId = null; // only recenter when the RUNNING node changes, not on every streamed chunk of the same node

  function applyDagZoom() {
    var svg = document.getElementById('dag');
    svg.setAttribute('width', String(dagContentW * dagZoom));
    svg.setAttribute('height', String(dagContentH * dagZoom));
    document.getElementById('dag-zoom-readout').textContent = Math.round(dagZoom * 100) + '%';
  }
  function setDagZoom(z, anchorClientX, anchorClientY) {
    var wrap = document.getElementById('canvas-wrap');
    var prevZoom = dagZoom;
    dagZoom = Math.max(DAG_ZOOM_MIN, Math.min(DAG_ZOOM_MAX, z));
    if (anchorClientX === undefined) {
      applyDagZoom();
      return;
    }
    // Keep the point under the cursor/pinch fixed in place rather than
    // always zooming toward the top-left corner of the scrollable area.
    var rect = wrap.getBoundingClientRect();
    var offsetX = anchorClientX - rect.left + wrap.scrollLeft;
    var offsetY = anchorClientY - rect.top + wrap.scrollTop;
    var ratio = dagZoom / prevZoom;
    applyDagZoom();
    wrap.scrollLeft = offsetX * ratio - (anchorClientX - rect.left);
    wrap.scrollTop = offsetY * ratio - (anchorClientY - rect.top);
  }
  function fitDagZoom() {
    var wrap = document.getElementById('canvas-wrap');
    var availW = wrap.clientWidth - 32, availH = wrap.clientHeight - 32; // minus the wrap's own padding
    if (availW <= 0 || availH <= 0) { setDagZoom(1); return; }
    setDagZoom(Math.max(DAG_ZOOM_MIN, Math.min(DAG_ZOOM_MAX, availW / dagContentW, availH / dagContentH)));
    wrap.scrollLeft = 0;
    wrap.scrollTop = 0;
  }

  var SVG_NS = 'http://www.w3.org/2000/svg'; // fixed XML namespace id required by createElementNS - never fetched over the network
  function el(tag, attrs, parent) {
    var e = document.createElementNS(SVG_NS, tag);
    for (var k in attrs) e.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(e);
    return e;
  }

  function htmlEl(tag, className, text) {
    var e = document.createElement(tag);
    if (className) e.className = className;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  // Real browser text metrics, not an estimate - SVG <text> has no CSS
  // text-overflow: ellipsis, and the node-clip clipPath alone (see the DAG
  // render loop) only stops overflow from bleeding into the next node's
  // box; it still hard-cuts mid-word with no signal that anything was
  // trimmed. Binary-searches the longest prefix that actually fits.
  function fitSvgText(el, text, maxWidth) {
    el.textContent = text;
    if (el.getComputedTextLength() <= maxWidth) return;
    var lo = 0, hi = text.length;
    while (lo < hi) {
      var mid = Math.ceil((lo + hi) / 2);
      el.textContent = text.slice(0, mid) + '\\u2026';
      if (el.getComputedTextLength() <= maxWidth) lo = mid; else hi = mid - 1;
    }
    el.textContent = text.slice(0, lo) + '\\u2026';
  }

  function findNode(list, id) {
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }

  function formatTokens(n) {
    return n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n);
  }

  // value is always a single already-combined figure (see the cost-fill
  // call site, which folds estimatedCostUsd in before calling this) - no
  // separate "incl ~$X est" suffix, matching the same one-number treatment
  // the agent-table Total row and mission control's aggregate use.
  function renderMeter(fillId, labelId, value, max, unit) {
    var fill = document.getElementById(fillId);
    var label = document.getElementById(labelId);
    var fmt = unit === '$' ? function (v) { return '$' + v.toFixed(2); }
      : unit === 'm' ? function (v) { return v.toFixed(0) + 'm'; }
      : function (v) { return String(v); };
    if (max === undefined || max === null) {
      // an EMPTY bar, not a full one: a full meter reads as "budget
      // exhausted", the opposite of "no budget applies" (audit SR-4)
      fill.style.width = '0%';
      fill.className = '';
      label.innerHTML = fmt(value) + '<span class="of"> no ' + (unit === '$' ? 'budget' : 'max') + ' set</span>';
      return;
    }
    var pct = max > 0 ? Math.min(100, (value / max) * 100) : 100;
    fill.style.width = pct + '%';
    fill.className = value > max ? 'over' : '';
    label.innerHTML = fmt(value) + '<span class="of"> / ' + fmt(max) + '</span>';
  }

  // startedTs/lastEventTs come from buildViewModel's own journal-event
  // timestamps (see view-model.ts) so the model itself stays a pure
  // function of the journal - the live "ticking" while a run is still in
  // progress happens only here, client-side, against the real wall clock.
  var wallGaugeTotals = null;
  var wallGaugeStatus = null;
  function renderWallGauge(totals, status) {
    wallGaugeTotals = totals;
    wallGaugeStatus = status;
    if (totals.startedTs === undefined) {
      renderMeter('wall-fill', 'wall-label', 0, totals.maxWallMinutes, 'm');
      return;
    }
    var endTs = status === 'running' ? Date.now() : (totals.lastEventTs !== undefined ? totals.lastEventTs : Date.now());
    var minutes = Math.max(0, (endTs - totals.startedTs) / 60000);
    renderMeter('wall-fill', 'wall-label', minutes, totals.maxWallMinutes, 'm');
    // Human wait vs compute split: a run whose 7 minutes were 5 minutes of a
    // human deciding at a gate is not a slow run. Completed gate waits come
    // from the model (humanWaitMs); a currently-open gate ticks live against
    // this client's clock (gateWaitingSinceTs) because no journal events
    // flow while a gate waits.
    var humanMs = (totals.humanWaitMs || 0)
      + (status === 'running' && totals.gateWaitingSinceTs ? Math.max(0, Date.now() - totals.gateWaitingSinceTs) : 0);
    var el = document.getElementById('wall-human');
    el.textContent = humanMs >= 5000 ? '· ' + (humanMs / 60000).toFixed(1) + 'm on you' : '';
  }
  setInterval(function () {
    if (wallGaugeStatus === 'running' && wallGaugeTotals) renderWallGauge(wallGaugeTotals, wallGaugeStatus);
  }, 1000);

  function renderDetail(node) {
    var panel = document.getElementById('detail-panel');
    var title = document.getElementById('inspector-title');
    var close = document.getElementById('inspector-close');
    if (!node) {
      panel.textContent = 'click a node in the graph to inspect its output and verdict history';
      title.textContent = 'Node inspector';
      close.style.display = 'none';
      return;
    }
    title.textContent = node.id + ' \u00b7 ' + node.role;
    close.style.display = '';
    var lines = [node.id + ' (' + node.role + ') - ' + node.status];
    node.iterations.slice().reverse().forEach(function (rec) {
      lines.push('');
      lines.push('iter ' + rec.iteration + ': ' + rec.status + (rec.evidence ? ' - ' + rec.evidence : ''));
      if (rec.output) lines.push(rec.output);
    });
    panel.textContent = lines.join('\\n');
  }

  function renderPlans(plans) {
    var container = document.getElementById('plans');
    var head = document.getElementById('plans-head');
    container.innerHTML = '';
    head.style.display = plans.length === 0 ? 'none' : 'block';
    plans.forEach(function (p) {
      var div = htmlEl('div', 'plan-version');
      var title = htmlEl('div', null, (p.replan === 0 ? 'initial plan' : 'replan #' + p.replan) + ' - iter ' + p.iteration);
      var pre = htmlEl('pre', null, p.output);
      div.appendChild(title);
      div.appendChild(pre);
      container.appendChild(div);
    });
  }

  function renderReport(report) {
    var head = document.getElementById('report-head');
    var panel = document.getElementById('report-panel');
    if (!report) { head.style.display = 'none'; panel.style.display = 'none'; return; }
    head.style.display = 'block';
    panel.style.display = 'block';
    var summary = document.getElementById('report-summary');
    summary.textContent = report.summary;
    if (report.source === 'fallback') {
      var note = htmlEl('span', 'report-source', '(mechanical - no reporting agent)');
      summary.appendChild(note);
    }
    var claims = document.getElementById('report-claims');
    claims.innerHTML = '';
    report.claims.forEach(function (c) {
      var row = htmlEl('div', 'claim-row');
      // A mechanical row (a gate, a parked wait) is not a confidence claim -
      // a red "0%" on "human approved"/"parked" misapplies percent semantics
      // to events that have no confidence at all (audit SR-7).
      var mechanical = /\\(gate\\)/.test(c.claim) || /^parked:/.test(c.reason || '');
      if (mechanical) {
        row.appendChild(htmlEl('span', 'claim-confidence', '\u00b7'));
      } else {
        var confClass = c.confidence >= 70 ? 'conf-high' : c.confidence >= 40 ? 'conf-mid' : 'conf-low';
        row.appendChild(htmlEl('span', 'claim-confidence ' + confClass, c.confidence + '%'));
      }
      var body = htmlEl('span', null);
      body.appendChild(htmlEl('span', 'claim-text', c.claim));
      body.appendChild(document.createTextNode(' - '));
      body.appendChild(htmlEl('span', 'claim-reason', c.reason));
      row.appendChild(body);
      claims.appendChild(row);
    });
    // Only ever rendered when there is something real to show: an absent or
    // empty filesTouched (no cwd to inspect, not a git repo, or nothing
    // changed - see core/git.ts/FinalReport.filesTouched) means no element
    // at all, not an empty expandable shell.
    var filesContainer = document.getElementById('files-touched-container');
    filesContainer.innerHTML = '';
    var files = report.filesTouched || [];
    if (files.length > 0) {
      var details = htmlEl('details', null);
      details.id = 'files-touched';
      var summary = htmlEl('summary', null, files.length + (files.length === 1 ? ' file' : ' files') + ' touched');
      details.appendChild(summary);
      var list = htmlEl('ul', null);
      files.forEach(function (f) {
        list.appendChild(htmlEl('li', null, f));
      });
      details.appendChild(list);
      filesContainer.appendChild(details);
    }
  }

  // Three separate, independently user-named layers describe every node -
  // role (fixed: executor/critic/tester/...), node id (this graph position,
  // e.g. "crit"), and agent (the reusable adapter+model assignment, e.g.
  // "checker") - the same agent can back several nodes, and the same role
  // can appear on several nodes too, so no single name stands in for the
  // others. The graph plate already shows all three together (id, then
  // role/agent/model); this table groups by agent, so it lists the node
  // id(s) that agent actually backed rather than repeating role alone -
  // otherwise "checker" here and "crit" on the graph read as unrelated.
  function renderAgentTable(nodes, totals) {
    var groups = {}
    var order = []
    nodes.forEach(function (n) {
      var key = n.agent || ('(' + n.role + ')')
      if (!groups[key]) { groups[key] = { label: key, adapter: n.adapter || '', model: n.model || '', nodeIds: [], calls: 0, tokens: 0, costUsd: 0, estimatedCostUsd: 0 }; order.push(key) }
      var g = groups[key]
      if (g.nodeIds.indexOf(n.id) === -1) g.nodeIds.push(n.id)
      g.calls += n.iterations.length
      g.tokens += n.tokens
      g.costUsd += n.costUsd
      g.estimatedCostUsd += n.estimatedCostUsd || 0
    })
    var table = document.getElementById('agent-table')
    table.innerHTML = ''
    var head = htmlEl('div', 'agent-row head')
    ;['Agent', 'Platform', 'Model', 'Nodes', 'Calls', 'Tokens', 'Cost'].forEach(function (h, i) {
      head.appendChild(htmlEl('span', i > 3 ? 'num' : null, h))
    })
    table.appendChild(head)
    if (order.length === 0) {
      table.appendChild(htmlEl('div', 'agent-row', '(no agent activity yet)'))
      return
    }
    order.forEach(function (key) {
      var g = groups[key]
      var row = htmlEl('div', 'agent-row')
      row.appendChild(htmlEl('span', null, g.label))
      row.appendChild(htmlEl('span', 'role', g.adapter || '-'))
      row.appendChild(htmlEl('span', 'role', g.model || '-'))
      var nodeIdsCell = htmlEl('span', 'role node-ids')
      g.nodeIds.forEach(function (id) { nodeIdsCell.appendChild(htmlEl('div', null, id)) })
      row.appendChild(nodeIdsCell)
      row.appendChild(htmlEl('span', 'num', String(g.calls)))
      row.appendChild(htmlEl('span', 'num', formatTokens(g.tokens)))
      row.appendChild(htmlEl('span', 'num', '$' + g.costUsd.toFixed(3) + (g.estimatedCostUsd ? (' (~$' + g.estimatedCostUsd.toFixed(3) + ' est)') : '')))
      table.appendChild(row)
    })
    var total = htmlEl('div', 'agent-row total')
    total.appendChild(htmlEl('span', null, 'Total'))
    total.appendChild(htmlEl('span', null, ''))
    total.appendChild(htmlEl('span', null, ''))
    total.appendChild(htmlEl('span', null, ''))
    total.appendChild(htmlEl('span', 'num', String(nodes.reduce(function (a, n) { return a + n.iterations.length }, 0))))
    total.appendChild(htmlEl('span', 'num', formatTokens(totals.tokens)))
    // The Total row combines real+estimated into one summed figure - same
    // reasoning as mission control's top-line aggregate (see renderUsage):
    // it answers "how much has this run spent so far", and a real-cost
    // agent sitting next to an estimate-only agent must not under-report
    // that. Per-agent rows above keep real vs. estimated visually distinct,
    // the same way mission control's per-run/per-workspace tiles do.
    total.appendChild(htmlEl('span', 'num', '$' + (totals.costUsd + totals.estimatedCostUsd).toFixed(3)))
    table.appendChild(total)
  }

  // A goal is commonly authored as a YAML "|" block scalar, which preserves
  // the source file's own hand-wrapped line breaks (e.g. wrapped at ~70
  // characters for readability in the .yaml file itself) as real newlines -
  // and this box's white-space: pre-wrap correctly honors them, rendering
  // at the SOURCE's wrap width instead of the box's actual (much wider)
  // width, leaving dead space on the right. Folding single newlines within
  // a paragraph into spaces (while keeping real blank-line paragraph
  // breaks) lets pre-wrap's own line-wrapping do its job at the box's real
  // width, regardless of how the YAML happened to be hand-formatted.
  function reflowGoal(text) {
    return text.split(/\\n\\s*\\n/).map(function (para) {
      return para.split('\\n').map(function (line) { return line.trim(); }).join(' ');
    }).join('\\n\\n');
  }

  // Streamed text is arbitrary model output rendered into a real DOM - escape
  // first, always, before any markdown-lite transform touches it.
  function escapeHtml(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // Deliberately minimal: **bold** only. A model's own reply routinely uses
  // this, and rendering it literally (asterisks and all) is the single
  // noisiest, most avoidable part of "wall of text" - full markdown parsing
  // is out of scope for a live streaming pane.
  function markdownLiteInline(escaped) {
    return escaped.replace(/\\*\\*(.+?)\\*\\*/g, '<strong>$1</strong>');
  }

  // A pure midpoint bend (0.5 between source's right edge and target's
  // left edge) can coincide EXACTLY across two unrelated edges - reproduced
  // live: two different-source edges landing at the same computed x, with
  // one source row's y also matching the other's bend-corner y, made two
  // separate edges (e.g. one node's own dependency, and an unrelated
  // skip-ahead edge) look like a single continuous line through a shared
  // node column. Deriving the bend fraction from the edge's own
  // (sourceId, targetId) identity instead of purely from geometry spreads
  // coincidentally-aligned edges apart while staying deterministic (same
  // edge always bends at the same fraction, so the graph doesn't jitter
  // between renders).
  function edgeBendFraction(sourceId, targetId) {
    var s = sourceId + '>' + targetId;
    var h = 0;
    for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return 0.35 + (h % 100) / 100 * 0.3;
  }

  function formatClockTime(ts) {
    var d = new Date(ts);
    var pad = function (n) { return n < 10 ? '0' + n : String(n); };
    return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
  }

  // Chunks arrive as raw token-ish slices with no paragraph structure of
  // their own. Blank-line splitting doesn't work here: several adapters
  // (verified live - copilot-cli's own tool-narration style is one) stream
  // terse, back-to-back thoughts with no blank line - or even a space -
  // between them ("...updating.Now check..."). A real pause between chunk
  // arrivals is a much more reliable break signal regardless of the model's
  // own punctuation habits: it reflects an actual gap in the agent's own
  // work (between tool calls, between turns), not a guess based on text
  // shape. Each chunk's own ts is a real journal arrival time already, so
  // grouping needs no extra bookkeeping to recover one after the fact.
  function paragraphsFromChunks(chunks) {
    // 600ms was too tight - back-to-back chunks with a normal thinking
    // pause between them (well under a real gap between tool calls/turns)
    // routinely exceeded it, breaking a single sentence into several
    // separately-timestamped paragraphs mid-word. 5s groups a genuine
    // burst of narration into one paragraph while still starting a fresh
    // one across a real pause (a tool call, a long generation gap).
    var GAP_MS = 5000;
    var groups = [];
    var current = null;
    chunks.forEach(function (c) {
      if (!current || (c.ts - current.ts) > GAP_MS) {
        current = { text: '', ts: c.ts };
        groups.push(current);
      }
      current.text += c.text;
      current.ts = c.ts;
    });
    return groups.filter(function (g) { return g.text.trim().length > 0; });
  }

  function renderLiveOutput(model) {
    var section = document.getElementById('live-output-section');
    var running = model.nodes.filter(function (n) { return n.status === 'running'; });
    if (running.length === 0) { section.style.display = 'none'; selectedTab = null; tabPinned = false; return; }
    section.style.display = 'block';
    // The most-recently-STARTED running node is the graph's frontier - the
    // one whose text the viewer almost always wants. running[] is in model
    // order (declaration order), so the last running entry is the newest.
    var frontier = running[running.length - 1].id;
    if (!findNode(running, selectedTab)) {
      // the tab we were showing is no longer running (it finished, or was
      // never valid) - drop any pin and jump to the frontier
      tabPinned = false;
      selectedTab = frontier;
    } else if (!tabPinned) {
      selectedTab = frontier; // auto-follow while unpinned
    }
    var tabs = document.getElementById('live-tabs');
    tabs.innerHTML = '';
    running.forEach(function (n) {
      var tab = htmlEl('div', 'tab' + (n.id === selectedTab ? ' active' : ''));
      tab.appendChild(htmlEl('span', 'tab-dot'));
      tab.appendChild(htmlEl('span', null, n.role + (n.agent ? ' \\u00b7 ' + n.agent : '') + (n.model ? ' \\u00b7 ' + n.model : '')));
      tab.title = n.id;
      tab.addEventListener('click', function () { selectedTab = n.id; tabPinned = true; renderLiveOutput(model); });
      tabs.appendChild(tab);
    });
    var current = findNode(running, selectedTab);
    var body = document.getElementById('live-output-body');
    body.innerHTML = '';
    if (!current || !current.streamingChunks || current.streamingChunks.length === 0) {
      body.textContent = (current && current.streamingOutput) ? current.streamingOutput : '(waiting for output...)';
    } else {
      var paras = paragraphsFromChunks(current.streamingChunks);
      paras.forEach(function (p, i) {
        // Newest paragraph at full opacity, older ones progressively
        // fainter - the point is making the newest text easy to find at a
        // glance in a fast-scrolling stream, not a precise gradient.
        var distanceFromEnd = paras.length - 1 - i;
        var opacity = distanceFromEnd === 0 ? 1 : distanceFromEnd === 1 ? 0.7 : distanceFromEnd === 2 ? 0.5 : 0.35;
        var div = htmlEl('div', 'stream-para');
        div.style.opacity = String(opacity);
        div.appendChild(htmlEl('span', 'stream-para-time', formatClockTime(p.ts)));
        var textEl = htmlEl('span', 'stream-para-text');
        textEl.innerHTML = markdownLiteInline(escapeHtml(p.text));
        div.appendChild(textEl);
        body.appendChild(div);
      });
    }
    if (current && current.status === 'running') {
      var cursor = htmlEl('span', 'cursor');
      body.appendChild(cursor);
    }
    body.scrollTop = body.scrollHeight;

    var meta = document.getElementById('live-meta');
    meta.innerHTML = '';
    if (current) {
      var r1 = htmlEl('div', 'row');
      r1.innerHTML = 'role <b>' + current.role + '</b>' + (current.agent ? ' \\u00b7 agent <b>' + current.agent + '</b>' : '');
      meta.appendChild(r1);
    }
    renderLivePermission(current);
  }

  // Shown only while the node currently displayed in the live-output panel
  // has a pendingPermission (model.nodes[i].pendingPermission, sourced from
  // dashboard/permission-registry.ts via view-model.ts's event fold) - a
  // genuinely different moment from a "role: gate" node's pendingGate: the
  // node's own subprocess is still running, blocked on ITS OWN stdin, not
  // the engine pausing between nodes (see permission-registry.ts's header
  // comment). Scoped to the live-output section, not the run-wide gate-row.
  var pendingPermissionNodeId = null;
  function renderLivePermission(current) {
    var row = document.getElementById('permission-row');
    if (!current || current.status !== 'running' || !current.pendingPermission) {
      row.style.display = 'none';
      pendingPermissionNodeId = null;
      return;
    }
    row.style.display = 'flex';
    pendingPermissionNodeId = current.id;
    document.getElementById('permission-label').textContent = current.pendingPermission.question;
  }

  function sendPermissionDecision(approved, text) {
    var statusEl = document.getElementById('permission-status');
    var approveBtn = document.getElementById('btn-permission-approve');
    var rejectBtn = document.getElementById('btn-permission-reject');
    if (!pendingPermissionNodeId) return;
    statusEl.className = '';
    statusEl.textContent = '';
    approveBtn.disabled = true;
    rejectBtn.disabled = true;
    var body = { action: 'answer-permission', nodeId: pendingPermissionNodeId, approved: approved };
    if (!approved && text) body.text = text;
    fetch('control', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }).then(function (r) {
      if (r.ok) {
        statusEl.className = 'ok';
        statusEl.textContent = approved ? 'approved' : 'denied';
        var input = document.getElementById('permission-reject-input');
        input.value = '';
        return refresh();
      }
      return r.json().then(function (respBody) {
        throw new Error(respBody.error || ('request failed (' + r.status + ')'));
      });
    }).catch(function (err) {
      statusEl.className = 'err';
      statusEl.textContent = err.message;
    }).then(function () {
      approveBtn.disabled = false;
      rejectBtn.disabled = false;
    });
  }

  document.getElementById('btn-permission-approve').addEventListener('click', function () {
    sendPermissionDecision(true);
  });
  document.getElementById('btn-permission-reject').addEventListener('click', function () {
    var input = document.getElementById('permission-reject-input');
    var text = input.value.trim();
    sendPermissionDecision(false, text);
  });
  document.getElementById('permission-reject-input').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') document.getElementById('btn-permission-reject').click();
  });

  function render(model) {
    document.getElementById('empty-state').style.display = model.nodes.length === 0 ? 'block' : 'none';
    document.getElementById('run-panel').style.display = model.nodes.length === 0 ? 'none' : 'block';
    document.getElementById('run-title').textContent = model.name || 'looprail dashboard';
    document.getElementById('run-id').textContent = model.runId ? 'RUN ' + model.runId : '';
    document.getElementById('run-goal').textContent = model.goal ? reflowGoal(model.goal.trim()) : '';
    var pill = document.getElementById('status-pill');
    pill.textContent = model.status;
    pill.className = 'status-pill status-' + model.status;

    // Halted (rail breach) vs canceled (deliberate user stop) reuse the
    // exact reason string the engine already wrote (view-model.ts) - this
    // layer only chooses presentation, never new wording. The banner is
    // hidden entirely outside those two statuses so it never reads as
    // routine metadata on a running/verified run.
    var reasonBanner = document.getElementById('reason-banner');
    var reasonLabel = document.getElementById('reason-label');
    if (model.reason && (model.status === 'halted' || model.status === 'canceled' || model.status === 'parked')) {
      reasonBanner.style.display = 'flex';
      reasonBanner.className = 'reason-banner reason-' + model.status;
      reasonLabel.textContent = model.status === 'canceled' ? 'Canceled' : model.status === 'parked' ? 'Parked' : 'Halted';
      document.getElementById('reason').textContent = model.reason;
    } else {
      reasonBanner.style.display = 'none';
      reasonBanner.className = 'reason-banner';
      reasonLabel.textContent = '';
      document.getElementById('reason').textContent = '';
    }

    var back = document.getElementById('back-link');
    back.style.display = location.pathname.indexOf('/run/') === 0 ? 'inline' : 'none';

    // Deliberately one combined figure, no "incl ~$X est" suffix - same
    // reasoning as the agent-table Total row and mission control's
    // aggregate: this is the top-line "how much has this run spent"
    // number, not a place to distinguish real from estimated.
    renderMeter(
      'cost-fill', 'cost-label',
      model.totals.costUsd + (model.totals.estimatedCostUsd || 0),
      model.totals.maxCostUsd, '$',
    );
    renderMeter('iter-fill', 'iter-label', model.totals.iteration, model.totals.maxIterations, '');
    document.getElementById('tokens-label').textContent = formatTokens(model.totals.tokens);
    document.getElementById('replans-label').textContent = String(model.totals.replans);
    document.getElementById('calls-label').textContent = String(model.totals.calls);
    renderWallGauge(model.totals, model.status);

    var byId = {};
    model.nodes.forEach(function (n) { byId[n.id] = n; });
    var layoutById = {};
    model.layout.forEach(function (l) { layoutById[l.id] = l; });

    var edgesG = document.getElementById('edges');
    var nodesG = document.getElementById('nodes');
    edgesG.innerHTML = '';
    nodesG.innerHTML = '';

    var BOX_W = 148, BOX_H = 58;
    model.edges.forEach(function (pair) {
      var a = layoutById[pair[0]], b = layoutById[pair[1]];
      if (!a || !b) return;
      var targetNode = byId[pair[1]];
      var isLive = targetNode && targetNode.status === 'running';
      var kind = pair[2] === 'of' ? ' edge-of' : '';
      var x1 = a.x + BOX_W, y1 = a.y + BOX_H / 2, x2 = b.x, y2 = b.y + BOX_H / 2;
      var midX = x1 + (x2 - x1) * edgeBendFraction(pair[0], pair[1]);
      var d = 'M ' + x1 + ' ' + y1 + ' L ' + midX + ' ' + y1 + ' L ' + midX + ' ' + y2 + ' L ' + x2 + ' ' + y2;
      var path = el('path', { class: 'trace' + (isLive ? ' edge-live' : '') + kind, d: d }, edgesG);
      var edgeTitle = el('title', {}, path);
      edgeTitle.textContent = pair[2] === 'of' ? pair[1] + ' reviews ' + pair[0] : pair[1] + ' runs after ' + pair[0];
    });

    model.layout.forEach(function (l) {
      var node = byId[l.id];
      if (!node) return;
      var statusClass = STATUS_CLASS[node.status] || 'node-pending';
      var g = el('g', { transform: 'translate(' + l.x + ',' + l.y + ')', 'clip-path': 'url(#node-clip)' }, nodesG);
      // selection: a signal ring OUTSIDE the plate, synced with the
      // inspector - the plate's own stroke keeps encoding STATUS, so a
      // selected failed node stays visibly failed
      if (selected === node.id) {
        el('rect', { class: 'node-ring', x: -3.5, y: -3.5, width: BOX_W + 7, height: BOX_H + 7, rx: 5 }, g);
      }
      el('rect', { class: 'node-plate ' + statusClass, width: BOX_W, height: BOX_H, rx: 3 }, g);
      el('circle', { class: 'node-dot ' + statusClass, cx: 10, cy: 14, r: 3 }, g);
      var maxTextWidth = BOX_W - 20 - 8;
      fitSvgText(el('text', { class: 'node-label', x: 20, y: 18 }, g), node.id, maxTextWidth);
      var subtext = node.role + (node.agent ? ' \u00b7 ' + node.agent : '') + (node.model ? ' \u00b7 ' + node.model : '');
      fitSvgText(el('text', { class: 'node-sub', x: 20, y: 31 }, g), subtext, maxTextWidth);
      // Telemetry ON the plate - the graph should answer cost/time/tokens
      // at a glance, not make every answer a click into the inspector.
      // Running nodes derive elapsed from their own stream timestamps (the
      // model is pure; SSE re-renders keep it fresh enough).
      var statsBits = [];
      var nodeCost = node.costUsd > 0 ? node.costUsd : node.estimatedCostUsd;
      if (nodeCost > 0) statsBits.push((node.costUsd > 0 ? '$' : '~$') + nodeCost.toFixed(2));
      if (node.status === 'running' && node.streamingChunks && node.streamingChunks.length > 0) {
        statsBits.push(Math.max(1, Math.round((node.streamingChunks[node.streamingChunks.length - 1].ts - node.streamingChunks[0].ts) / 1000)) + 's\u2026');
      } else {
        var lastRec = node.iterations.length ? node.iterations[node.iterations.length - 1] : null;
        if (lastRec && lastRec.durationMs) statsBits.push(Math.round(lastRec.durationMs / 1000) + 's');
      }
      if (node.tokens > 0) statsBits.push(formatTokens(node.tokens));
      el('text', { class: 'node-stats', x: 20, y: 47 }, g).textContent = statsBits.join(' \u00b7 ');
      // attempt pips, oldest->newest, last 6 - a green node that failed
      // twice on the way shows its history without a click
      var recs = node.iterations.slice(-6);
      recs.forEach(function (rec, i) {
        var pipClass = rec.status === 'pass' || rec.status === 'done' ? 'pip-pass'
          : rec.status === 'fail' || rec.status === 'error' || rec.status === 'stall' ? 'pip-fail'
          : rec.status === 'parked' ? 'pip-parked' : 'pip-other';
        var pip = el('circle', { class: pipClass, cx: BOX_W - 10 - (recs.length - 1 - i) * 8, cy: 47, r: 2.5 }, g);
        var pipTitle = el('title', {}, pip);
        pipTitle.textContent = 'iter ' + rec.iteration + ': ' + rec.status + (rec.evidence ? ' - ' + rec.evidence.slice(0, 120) : '');
      });
      g.addEventListener('click', function () { selected = node.id; renderDetail(node); refresh(); });
    });

    var svg = document.getElementById('dag');
    var maxX = 0, maxY = 0;
    model.layout.forEach(function (l) { maxX = Math.max(maxX, l.x + BOX_W + 40); maxY = Math.max(maxY, l.y + BOX_H + 40); });
    dagContentW = Math.max(maxX, 400);
    dagContentH = Math.max(maxY, 200);
    svg.setAttribute('viewBox', '0 0 ' + dagContentW + ' ' + dagContentH);
    // width/height are driven by dagZoom (see applyDagZoom), not left at the
    // static markup's "100%" - with a fixed-percentage width the SVG's
    // default preserveAspectRatio scales the WHOLE graph down to keep it
    // fully visible instead of ever overflowing, so a deep dependency chain
    // (e.g. a self-planning splice's mostly-linear node sequence, which
    // grows by layer i.e. by x, not by y) just got progressively squished
    // and unreadable. Setting real pixel width/height lets the graph render
    // at a legible scale and only then genuinely overflow #canvas-wrap,
    // with the zoom controls adjusting that scale explicitly.
    applyDagZoom();

    // Follow the currently RUNNING node, not a fixed corner - a bottom-right
    // scroll snap was wrong for a bushy or backward-growing graph, and
    // recentering on every single streamed chunk (rather than only when the
    // running node itself changes) fought any zoom/pan the user was doing
    // mid-stream. No running node (halted/done) leaves scroll untouched.
    var runningNode = model.nodes.find(function (n) { return n.status === 'running'; });
    if (runningNode && runningNode.id !== lastAutoScrollNodeId) {
      lastAutoScrollNodeId = runningNode.id;
      var runningLayout = layoutById[runningNode.id];
      if (runningLayout) {
        var canvasWrap = document.getElementById('canvas-wrap');
        var centerX = (runningLayout.x + BOX_W / 2) * dagZoom;
        var centerY = (runningLayout.y + BOX_H / 2) * dagZoom;
        canvasWrap.scrollLeft = Math.max(0, centerX - canvasWrap.clientWidth / 2);
        canvasWrap.scrollTop = Math.max(0, centerY - canvasWrap.clientHeight / 2);
      }
    } else if (!runningNode) {
      lastAutoScrollNodeId = null;
    }

    renderAgentTable(model.nodes, model.totals);
    renderPlans(model.plans);
    renderReport(model.report);
    if (selected && byId[selected]) renderDetail(byId[selected]);
    renderLiveOutput(model);
    renderControls(model);
    renderGateRow(model);
    renderFeedbackRow(model);
    renderResumeRow(model);
  }

  function renderControls(model) {
    var controls = document.getElementById('run-controls');
    // controllable comes from the server (server.ts's controlState): it
    // reflects whether run-cmd.ts recorded a pid for this run at all, not
    // just whether the run is still going - an older run, or one started by
    // a different tool entirely, has nothing here to pause or cancel.
    if (model.status !== 'running' || !model.controllable) {
      controls.style.display = 'none';
      return;
    }
    controls.style.display = 'flex';
    var pauseBtn = document.getElementById('btn-pause');
    var cancelBtn = document.getElementById('btn-cancel');
    // render() is the only place either button's disabled state is decided
    // once a request settles - sendControl only disables both up front, to
    // block a double-click while one is in flight.
    cancelBtn.disabled = false;
    pauseBtn.textContent = model.paused ? 'Resume' : 'Pause';
    // pauseUnsafe means this exact dashboard is served by the same process
    // pausing would freeze - looprail run --ui, not mission control. Resume
    // is unaffected: it only ever applies to an already-paused run, and a
    // process cannot pause itself and serve this page at the same time.
    pauseBtn.disabled = model.pauseUnsafe && !model.paused;
    pauseBtn.title = pauseBtn.disabled
      ? 'Open this run from looprail ui --all (mission control) to pause it - pausing it here would freeze this dashboard too'
      : '';
  }

  function sendControl(action) {
    var errorEl = document.getElementById('control-error');
    var pauseBtn = document.getElementById('btn-pause');
    var cancelBtn = document.getElementById('btn-cancel');
    errorEl.textContent = '';
    pauseBtn.disabled = true;
    cancelBtn.disabled = true;
    fetch('control', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: action }),
    }).then(function (r) {
      if (r.ok) return refresh(); // refresh()'s render() sets each button's correct state - nothing else needed on success
      return r.json().then(function (body) {
        throw new Error(body.error || ('request failed (' + r.status + ')'));
      });
    }).catch(function (err) {
      errorEl.textContent = err.message;
      // only the failure path needs to manually restore both buttons -
      // render() never ran to set their real state for us
      pauseBtn.disabled = false;
      cancelBtn.disabled = false;
    });
  }

  document.getElementById('inspector-close').addEventListener('click', function () {
    selected = null;
    renderDetail(null);
  });
  document.getElementById('btn-pause').addEventListener('click', function () {
    sendControl(this.textContent === 'Resume' ? 'resume' : 'pause');
  });
  document.getElementById('btn-cancel').addEventListener('click', function () {
    if (!confirm('Cancel this run? It will halt immediately and cannot be resumed.')) return;
    sendControl('cancel');
  });

  // Shown only while a gate is actually waiting on this run (model.pendingGate,
  // from this process's gate registry or the run directory's gate-waiting
  // marker - see src/dashboard/server.ts) - a permanently-visible
  // approve/reject control would be misleading since most of a run's life
  // has no gate open. Rendered as a FIXED bottom bar with the full question
  // text inline: the human must be able to read what they're approving and
  // click approve without scrolling anywhere (live-caught complaint: the
  // old in-panel row left the button off-screen and the content elsewhere).
  function renderGateRow(model) {
    var bar = document.getElementById('gate-bar');
    if (model.status !== 'running' || !model.pendingGate) {
      bar.style.display = 'none';
      document.body.classList.remove('gate-open');
      return;
    }
    bar.style.display = 'flex';
    document.body.classList.add('gate-open');
    document.getElementById('gate-label').textContent = (model.pendingGate.isPlanApproval
      ? 'Plan awaiting your approval'
      : 'Gate awaiting your approval') + ' - ' + model.pendingGate.nodeId;
    // textContent, never innerHTML - the question embeds arbitrary agent
    // output. Written ONLY when it actually changed: render() runs on every
    // poll tick, and rewriting identical textContent replaces the child
    // node, which silently resets the reader's scroll position to the top
    // every second (live-caught: "I can't scroll inside the approval box").
    var questionEl = document.getElementById('gate-question');
    var questionText = model.pendingGate.question || '';
    if (questionEl.textContent !== questionText) questionEl.textContent = questionText;
  }

  function sendGateDecision(action, text) {
    var statusEl = document.getElementById('gate-status');
    var approveBtn = document.getElementById('btn-gate-approve');
    var rejectBtn = document.getElementById('btn-gate-reject');
    statusEl.className = '';
    statusEl.textContent = '';
    approveBtn.disabled = true;
    rejectBtn.disabled = true;
    var body = action === 'reject-gate' ? { action: action, text: text } : { action: action };
    fetch('control', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }).then(function (r) {
      if (r.ok) {
        statusEl.className = 'ok';
        statusEl.textContent = action === 'approve-gate' ? 'approved' : 'rejected';
        var input = document.getElementById('gate-reject-input');
        input.value = '';
        return refresh();
      }
      return r.json().then(function (respBody) {
        throw new Error(respBody.error || ('request failed (' + r.status + ')'));
      });
    }).catch(function (err) {
      statusEl.className = 'err';
      statusEl.textContent = err.message;
    }).then(function () {
      approveBtn.disabled = false;
      rejectBtn.disabled = false;
    });
  }

  document.getElementById('btn-gate-approve').addEventListener('click', function () {
    sendGateDecision('approve-gate');
  });
  document.getElementById('btn-gate-reject').addEventListener('click', function () {
    var input = document.getElementById('gate-reject-input');
    var text = input.value.trim();
    if (!text) return;
    sendGateDecision('reject-gate', text);
  });
  document.getElementById('gate-reject-input').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') document.getElementById('btn-gate-reject').click();
  });

  // Shown only while the run is actually running (see renderFeedbackRow) -
  // a note dropped here is read once at the top of the very next iteration
  // (runner.ts drains journal/human-feedback.js) and never repeats after.
  function renderFeedbackRow(model) {
    document.getElementById('feedback-row').style.display =
      model.status === 'running' && model.controllable ? 'flex' : 'none';
  }

  function sendFeedback() {
    var input = document.getElementById('feedback-input');
    var statusEl = document.getElementById('feedback-status');
    var btn = document.getElementById('btn-feedback');
    var text = input.value.trim();
    if (!text) return;
    statusEl.className = '';
    statusEl.textContent = '';
    btn.disabled = true;
    fetch('control', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'feedback', text: text }),
    }).then(function (r) {
      if (r.ok) {
        statusEl.className = 'ok';
        statusEl.textContent = 'queued for the next iteration';
        input.value = '';
        return;
      }
      return r.json().then(function (body) {
        throw new Error(body.error || ('request failed (' + r.status + ')'));
      });
    }).catch(function (err) {
      statusEl.className = 'err';
      statusEl.textContent = err.message;
    }).then(function () {
      btn.disabled = false;
    });
  }

  document.getElementById('btn-feedback').addEventListener('click', sendFeedback);
  document.getElementById('feedback-input').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') sendFeedback();
  });

  // Prefilled once, the first time this halted run is seen as resumable -
  // repeated SSE-driven renders while the user is mid-edit must not stomp
  // on values they are actively typing.
  var resumeFormInitialized = false;

  function renderResumeRow(model) {
    var row = document.getElementById('resume-row');
    if ((model.status !== 'halted' && model.status !== 'parked') || !model.resumable) {
      row.style.display = 'none';
      resumeFormInitialized = false; // a later, different halted run starts fresh
      return;
    }
    row.style.display = 'flex';
    document.getElementById('resume-hint').textContent = model.status === 'parked'
      ? 'the gate will ask again - everything already done is cached, nothing re-runs'
      : 'continues this same run with its remaining budget';
    if (!resumeFormInitialized) {
      document.getElementById('resume-iterations').value =
        model.totals.maxIterations != null ? model.totals.maxIterations : '';
      document.getElementById('resume-cost').value =
        model.totals.maxCostUsd != null ? model.totals.maxCostUsd : '';
      document.getElementById('resume-wall-minutes').value =
        model.totals.maxWallMinutes != null ? model.totals.maxWallMinutes : '';
      document.getElementById('resume-replan-limit').value =
        model.totals.replanLimit != null ? model.totals.replanLimit : '';
      // Prefill the goal editor with the run's current goal so a user can tweak
      // unclear wording before resuming (GAP 2) - goal-only for this first cut.
      document.getElementById('resume-goal').value = model.goal != null ? model.goal : '';
      // a stale "resuming…" from a previous click must not linger once this
      // is a fresh halted state (the run genuinely halted again, or for the
      // first time) - only sendResume() itself sets this text, nothing else
      // ever clears it otherwise.
      var statusEl = document.getElementById('resume-status');
      statusEl.className = '';
      statusEl.textContent = '';
      resumeFormInitialized = true;
    }
  }

  // A blank numeric input's .value is '', and Number('') is 0, not NaN - so
  // without this, leaving an OPTIONAL rail field blank (common: many
  // loopfiles set no max_wall_minutes/replan_limit at all) silently sent 0,
  // which the server rejects as "must be a positive number", failing the
  // whole resume request over a field the user never meant to touch.
  function numOrUndefined(id) {
    var v = document.getElementById(id).value;
    return v === '' ? undefined : Number(v);
  }

  // plain=true is the one-click primary resume: NO overrides at all - the
  // run continues exactly as configured (for parked runs, the gate simply
  // asks again). The Advanced form's own button still sends its fields.
  function sendResume(plain) {
    var statusEl = document.getElementById('resume-status');
    var btn = document.getElementById(plain ? 'btn-resume-now' : 'btn-resume');
    var iterations = plain ? undefined : numOrUndefined('resume-iterations');
    var cost = plain ? undefined : numOrUndefined('resume-cost');
    var wallMinutes = plain ? undefined : numOrUndefined('resume-wall-minutes');
    var replanLimit = plain ? undefined : numOrUndefined('resume-replan-limit');
    // Trimmed; undefined when blank so the server keeps the loopfile's own goal
    // (the goal override never mutates the source file - see ResumeOverrides.goal).
    var goal = plain ? undefined : (document.getElementById('resume-goal').value.trim() || undefined);
    statusEl.className = '';
    statusEl.textContent = '';
    btn.disabled = true;
    fetch('resume', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ maxIterations: iterations, maxCostUsd: cost, maxWallMinutes: wallMinutes, replanLimit: replanLimit, goal: goal }),
    }).then(function (r) {
      if (r.ok) {
        statusEl.className = 'ok';
        statusEl.textContent = 'resuming…';
        return refresh();
      }
      return r.json().then(function (body) {
        throw new Error(body.error || ('request failed (' + r.status + ')'));
      });
    }).catch(function (err) {
      statusEl.className = 'err';
      statusEl.textContent = err.message;
    }).then(function () {
      btn.disabled = false;
    });
  }

  document.getElementById('btn-resume').addEventListener('click', function () { sendResume(false); });
  document.getElementById('btn-resume-now').addEventListener('click', function () { sendResume(true); });

  document.getElementById('dag-zoom-in').addEventListener('click', function () { setDagZoom(dagZoom + DAG_ZOOM_STEP); });
  document.getElementById('dag-zoom-out').addEventListener('click', function () { setDagZoom(dagZoom - DAG_ZOOM_STEP); });
  document.getElementById('dag-zoom-fit').addEventListener('click', fitDagZoom);

  var dagWrap = document.getElementById('canvas-wrap');
  // Ctrl/Cmd+wheel zooms (the conventional browser-zoom gesture); plain
  // wheel is left alone so normal two-axis scrolling over the graph still
  // works exactly like any other scrollable panel.
  dagWrap.addEventListener('wheel', function (e) {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    setDagZoom(dagZoom + (e.deltaY < 0 ? DAG_ZOOM_STEP : -DAG_ZOOM_STEP), e.clientX, e.clientY);
  }, { passive: false });

  // Click-drag to pan. Tracked via a movement threshold so a plain click on
  // a node (which fires its own click handler on mouseup) never gets
  // swallowed as an accidental pan.
  var panState = null;
  dagWrap.addEventListener('mousedown', function (e) {
    if (e.button !== 0) return;
    panState = { startX: e.clientX, startY: e.clientY, scrollLeft: dagWrap.scrollLeft, scrollTop: dagWrap.scrollTop, moved: false };
  });
  window.addEventListener('mousemove', function (e) {
    if (!panState) return;
    var dx = e.clientX - panState.startX, dy = e.clientY - panState.startY;
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) panState.moved = true;
    if (!panState.moved) return;
    dagWrap.classList.add('panning');
    dagWrap.scrollLeft = panState.scrollLeft - dx;
    dagWrap.scrollTop = panState.scrollTop - dy;
  });
  window.addEventListener('mouseup', function () {
    if (panState && panState.moved) dagWrap.classList.remove('panning');
    panState = null;
  });

  // Root cause of a real observed bug: /events replays the ENTIRE journal
  // history as one SSE frame per event on every new connection (by design -
  // see sse.ts - so a client opening the dashboard after the run finished
  // still gets full history). For a long, self-planning run with 1000+
  // journal events, that means es.onmessage below fires 1000+ times in a
  // single burst on page load, all before the first fetch('model') can
  // possibly resolve. refresh() used to have no in-flight guard, so every
  // one of those messages launched its own overlapping fetch('model') -
  // hundreds of concurrent same-origin requests, which is exactly what
  // produces the browser's net::ERR_INSUFFICIENT_RESOURCES (browsers cap
  // pending same-origin requests) followed by "Failed to fetch" rejections.
  // This is a genuine client bug, not a testing-tool artifact or a
  // reconnect storm - it reproduces from one page load, one EventSource
  // connection, zero reconnects. The fix is a single-flight guard: at most
  // one fetch('model') in flight at a time, plus a single coalesced
  // "refresh again once this settles" flag so a burst of N messages still
  // ends with the model fully up to date, but never launches more than one
  // overlapping request - this scales correctly with both an initial replay
  // burst and normal rapid-fs-write bursts, unlike a rate limit/debounce
  // which would just delay the same overload.
  var refreshInFlight = false;
  var refreshAgainQueued = false;
  function refresh() {
    if (refreshInFlight) {
      refreshAgainQueued = true;
      return Promise.resolve();
    }
    refreshInFlight = true;
    // Relative, not '/model': this same page is served both standalone at
    // '/' (looprail ui) and nested at '/run/<hash>/<runId>/' (mission
    // control), and a leading slash would always hit the site root's route,
    // 404ing under mission control. The server enforces a trailing slash on
    // this page's own URL (see startMissionControlServer) specifically so
    // this relative resolution is reliable either way.
    return fetch('model').then(function (r) { return r.json(); }).then(render).catch(function (err) {
      console.error('failed to refresh dashboard model', err);
    }).then(function () {
      refreshInFlight = false;
      if (refreshAgainQueued) {
        refreshAgainQueued = false;
        refresh();
      }
    });
  }

  refresh();
  var es = new EventSource('events');
  es.onmessage = function () { refresh(); };
})();
</script>
</body>
</html>`
}
