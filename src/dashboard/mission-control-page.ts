// Self-contained mission-control page: a card grid across every registered
// workspace's runs, plus a secondary section for raw Claude Code sessions.
// Same house style as page.ts - inline CSS/JS, no external requests, no
// framework, same :root design tokens. The client is a thin re-fetcher
// exactly like page.ts (design decision 7 from the 2026-07-02 dashboard
// plan): it never derives status/cost/agents/tokens itself, it only renders
// what /api/runs and /events already computed server-side.
//
// Server contract this client is written against (Task 10 builds the
// server): GET /api/runs -> { runs: RunListEntry[], sessions: SessionEntry[] }
// and every /events SSE frame carries that same combined shape as its data.
export function buildMissionControlPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>looprail mission control</title>
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
      radial-gradient(1200px 600px at 50% -100px, rgba(232,196,104,0.05), transparent 60%),
      linear-gradient(rgba(50,45,38,0.55) 1px, transparent 1px),
      linear-gradient(90deg, rgba(50,45,38,0.55) 1px, transparent 1px);
    background-size: auto, 48px 48px, 48px 48px; background-position: 0 0, -1px -1px, -1px -1px;
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
    padding-bottom: 20px; border-bottom: 1px solid var(--line); margin-bottom: 24px; flex-wrap: wrap;
  }
  .wordmark { font-family: var(--mono); font-size: 14px; font-weight: 600; letter-spacing: 0.02em; display: flex; align-items: center; gap: 9px; }
  .wordmark .dot { width: 7px; height: 7px; border-radius: 1px; background: var(--signal); box-shadow: 0 0 8px 1px rgba(232,196,104,0.55); animation: pulse-dot 2.4s ease-in-out infinite; }
  #run-count { font: 12px var(--mono); color: var(--ink-dim); }

  .usage-strip {
    display: flex; align-items: stretch; justify-content: space-between; gap: 20px; flex-wrap: wrap;
    padding: 0; margin-bottom: 28px; border: 1px solid var(--line); border-radius: 4px;
    background: linear-gradient(180deg, var(--panel-raised), var(--panel));
    box-shadow: 0 1px 0 rgba(255,255,255,0.03) inset, 0 8px 24px rgba(0,0,0,0.35);
    overflow: hidden;
  }
  .usage-figures { display: flex; flex-wrap: wrap; flex: 1; }
  .usage-item {
    display: flex; flex-direction: column; gap: 3px; justify-content: center;
    padding: 14px 22px; border-right: 1px solid var(--line); min-width: 96px;
  }
  .usage-item .label { font: 600 9px var(--sans); letter-spacing: 0.14em; text-transform: uppercase; color: var(--ink-faint); }
  .usage-item .value { font: 17px var(--mono); font-variant-numeric: tabular-nums; color: var(--ink); }
  .range-picker { display: flex; gap: 4px; align-items: center; padding: 0 16px; }

  .range-btn { font: 11px var(--mono); padding: 5px 10px; border-radius: 3px; border: 1px solid var(--line); background: var(--panel-raised); color: var(--ink-dim); cursor: pointer; }
  .range-btn:hover { color: var(--ink); }
  .range-btn.active { color: var(--signal); border-color: rgba(232,196,104,0.4); background: rgba(232,196,104,0.1); }

  .section-head { display: flex; align-items: center; justify-content: space-between; margin: 32px 0 12px; gap: 16px; flex-wrap: wrap; }
  .section-head h2 { font-family: var(--sans); font-size: 12px; font-weight: 600; letter-spacing: 0.1em; text-transform: uppercase; color: var(--ink-dim); margin: 0; }

  main { }
  #grid, #needs-grid, #running-grid {
    display: grid; grid-template-columns: repeat(auto-fill, minmax(250px, 1fr)); gap: 12px;
  }
  /* Card anatomy - identical slots on every card so the board reads as a
     designed system, not a pile: status rail | name+pill | reason? | goal
     (fixed 2-line box) | 4-slot labeled stats | footer. The status is
     encoded twice on purpose: the pill names it, the left rail makes a
     wall of cards scannable by color alone. */
  .run-card {
    position: relative; display: flex; flex-direction: column; gap: 8px;
    padding: 13px 16px 11px 18px; border-radius: 4px;
    background: linear-gradient(180deg, var(--panel-raised), var(--panel) 70%);
    border: 1px solid var(--line); text-decoration: none; color: inherit;
    box-shadow: 0 1px 0 rgba(255,255,255,0.02) inset, 0 2px 10px rgba(0,0,0,0.25);
    transition: border-color 0.15s ease, transform 0.15s ease, box-shadow 0.15s ease;
    overflow: hidden;
  }
  .run-card::before {
    content: ''; position: absolute; left: 0; top: 0; bottom: 0; width: 3px;
    background: var(--rail, var(--line-bright));
  }
  .run-card.rail-running { --rail: var(--signal); }
  .run-card.rail-verified { --rail: var(--pass); }
  .run-card.rail-halted { --rail: var(--warn); }
  .run-card.rail-canceled, .run-card.rail-stale { --rail: var(--ink-faint); }
  .run-card.rail-parked, .run-card.rail-gate { --rail: var(--signal); }
  .run-card:hover, .run-card:focus-visible {
    border-color: var(--line-bright); transform: translateY(-2px);
    box-shadow: 0 8px 24px rgba(0,0,0,0.45);
  }
  .run-card .top { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
  .run-card .name { font: 600 13.5px var(--mono); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .run-card .goal {
    font-size: 11.5px; color: var(--ink-dim); line-height: 1.45;
    display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
    min-height: calc(2 * 1.45 * 11.5px);
  }
  .run-card .reason {
    font-size: 11px; line-height: 1.4;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .run-card .stats {
    display: grid; grid-template-columns: repeat(4, 1fr); gap: 0;
    border-top: 1px solid var(--line); padding-top: 8px; margin-top: auto;
  }
  .run-card .stat { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
  .run-card .stat-label { font: 600 8.5px var(--sans); letter-spacing: 0.12em; text-transform: uppercase; color: var(--ink-faint); }
  .run-card .stat-value { font: 12px var(--mono); font-variant-numeric: tabular-nums; color: var(--ink); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .run-card .stat-value .of { color: var(--ink-faint); }
  .run-card .stat.wall-over .stat-value { color: var(--fail); }
  .run-card .card-footer {
    display: flex; align-items: center; justify-content: space-between; gap: 8px;
    font: 10px var(--mono); color: var(--ink-faint);
  }
  .run-card .card-footer .ws { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .run-card .card-footer .when { flex-shrink: 0; }
  .run-card .reason.reason-halted { color: var(--warn); }
  .run-card .reason.reason-canceled { color: var(--ink-dim); }
  .status-pill {
    display: inline-flex; align-items: center; gap: 6px; font: 600 10.5px/1.4 var(--mono);
    letter-spacing: 0.08em; text-transform: uppercase; padding: 4px 9px 4px 7px; border-radius: 3px;
    border: 1px solid transparent; white-space: nowrap; flex-shrink: 0;
  }
  .status-pill::before { content: ''; width: 6px; height: 6px; border-radius: 1px; background: currentColor; display: inline-block; }
  .status-running { color: var(--signal); background: rgba(232,196,104,0.12); border-color: rgba(232,196,104,0.32); }
  .status-running::before { animation: pulse-dot 1.6s ease-in-out infinite; }
  .status-verified { color: var(--pass); background: rgba(127,166,107,0.12); border-color: rgba(127,166,107,0.3); }
  .status-halted { color: var(--warn); background: rgba(184,134,61,0.12); border-color: rgba(184,134,61,0.3); }
  .status-canceled { color: var(--ink-dim); background: rgba(140,131,117,0.12); border-color: rgba(140,131,117,0.3); }
  /* parked: waiting on a human, nothing failed - signal family, steady (no
     pulse: it isn't burning compute). stale: journal says running but the
     process is dead - dim + struck, honestly neither running nor finished. */
  .status-parked { color: var(--signal); background: rgba(232,196,104,0.12); border-color: rgba(232,196,104,0.32); }
  .status-stale { color: var(--ink-faint); background: rgba(140,131,117,0.08); border-color: rgba(140,131,117,0.2); text-decoration: line-through; }
  .status-gate { color: var(--signal); background: rgba(232,196,104,0.18); border-color: rgba(232,196,104,0.45); }
  .status-gate::before { animation: pulse-dot 1.6s ease-in-out infinite; }
  .run-card .reason.reason-parked { color: var(--signal); }
  .needs-head {
    font: 600 11px var(--sans); letter-spacing: 0.1em; text-transform: uppercase;
    color: var(--signal); margin: 4px 0 8px; display: flex; align-items: center; gap: 8px;
  }
  .needs-head::after { content: ''; flex: 1; height: 1px; background: rgba(232,196,104,0.25); }
  #needs-grid { margin-bottom: 22px; }
  #needs-grid .run-card { border-color: rgba(232,196,104,0.4); }
  #running-grid { margin-bottom: 22px; }
  .board-head {
    font: 600 10.5px var(--sans); letter-spacing: 0.12em; text-transform: uppercase;
    color: var(--ink-dim); margin: 4px 0 10px; display: flex; align-items: center; gap: 10px;
  }
  .board-head::after { content: ''; flex: 1; height: 1px; background: var(--line); }
  .show-all-btn {
    grid-column: 1 / -1; padding: 9px; font: 11px var(--mono); cursor: pointer;
    background: var(--panel); border: 1px dashed var(--line-bright); border-radius: 3px;
    color: var(--ink-dim); transition: color 0.15s ease, border-color 0.15s ease;
  }
  .show-all-btn:hover { color: var(--ink); border-color: var(--signal-dim); }
  @keyframes pulse-dot { 50% { opacity: 0.35; } }
  .run-card .agents { font-size: 11.5px; color: var(--ink-dim); margin-bottom: 10px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .run-card .stats { display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap; }
  .run-card .stats .num { font: 11.5px var(--mono); font-variant-numeric: tabular-nums; color: var(--ink-dim); }
  .run-card .stats .num b { color: var(--ink); font-weight: 500; }
  .run-card .stats .num.wall-over { color: var(--fail); }
  .run-card .stats .num.wall-over b { color: var(--fail); font-weight: 600; }
  .run-card .updated { font: 10.5px var(--mono); color: var(--ink-faint); margin-top: 8px; }
  #empty-state {
    padding: 60px 20px; text-align: center; color: var(--ink-dim); max-width: 520px; margin: 0 auto;
  }
  #sessions-section { margin-top: 32px; padding-top: 20px; border-top: 1px solid var(--line); }
  #sessions-section h2 {
    font-size: 12px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--ink-dim); margin: 0 0 10px;
  }
  #sessions-details summary {
    cursor: pointer; font: 600 11px var(--sans); letter-spacing: 0.08em;
    text-transform: uppercase; color: var(--ink-faint); margin-bottom: 8px;
  }
  #sessions-details summary:hover { color: var(--ink-dim); }
  #sessions-grid {
    display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 8px;
  }
  .session-card {
    padding: 10px; border-radius: 3px; background: transparent; border: 1px dashed var(--line);
  }
  .session-badge {
    font: 600 10px var(--mono); text-transform: uppercase; letter-spacing: 0.08em;
    color: var(--ink-faint); display: inline-block; margin-bottom: 6px;
  }
  .session-card .workspace { font-size: 12px; color: var(--ink-dim); margin-bottom: 2px; }
  .session-card .session-id { font: 11px var(--mono); color: var(--ink-faint); margin-bottom: 4px; }
  .session-badge.tool-claude-code { color: #c98a4b; border-color: rgba(201,138,75,0.4); }
  .session-badge.tool-copilot-cli { color: #7fa66b; border-color: rgba(127,166,107,0.4); }
  .session-badge.tool-codex { color: #6b9fa6; border-color: rgba(107,159,166,0.4); }
  .session-badge.tool-aider { color: #a66b9f; border-color: rgba(166,107,159,0.4); }
  .session-card .meta { font: 11px var(--mono); color: var(--ink-faint); }
  @media (prefers-reduced-motion: reduce) {
    .status-running::before { animation: none !important; }
    .run-card { transition: none !important; }
    .run-card:hover, .run-card:focus-visible { transform: none; }
  }
</style>
</head>
<body>
<div class="wrap">
  <div class="masthead">
    <div class="wordmark"><span class="dot"></span> LOOPRAIL MISSION CONTROL</div>
    <span id="run-count"></span>
  </div>
  <div class="usage-strip">
    <div class="usage-figures">
      <div class="usage-item"><span class="label">Workspaces</span><span class="value" id="usage-workspaces">0</span></div>
      <div class="usage-item"><span class="label">Runs</span><span class="value" id="usage-runs">0</span></div>
      <div class="usage-item"><span class="label">Running now</span><span class="value" id="usage-running">0</span></div>
      <div class="usage-item"><span class="label">Cost</span><span class="value" id="usage-cost">$0.00</span></div>
      <div class="usage-item"><span class="label">Tokens</span><span class="value" id="usage-tokens">0</span></div>
      <div class="usage-item"><span class="label">Wall time</span><span class="value" id="usage-wall">0s</span></div>
    </div>
    <div class="range-picker" id="range-picker"></div>
  </div>
  <main>
    <div id="empty-state" style="display:none"></div>
    <div class="needs-head" id="needs-head" style="display:none">Needs you</div>
    <div id="needs-grid"></div>
    <div class="board-head" id="running-head" style="display:none">Running</div>
    <div id="running-grid"></div>
    <div class="board-head" id="history-head" style="display:none">History</div>
    <div id="grid"></div>
    <section id="sessions-section" style="display:none">
      <details id="sessions-details">
        <summary id="sessions-heading">Recent Claude Code activity</summary>
        <div id="sessions-grid"></div>
      </details>
    </section>
  </main>
</div>
<footer class="site-footer">
  <span class="brand">looprail</span>
  <nav>
    <a href="https://github.com/saimeda32/looprail" target="_blank" rel="noopener">GitHub</a>
    <a href="https://github.com/saimeda32/looprail#readme" target="_blank" rel="noopener">README</a>
    <a href="https://github.com/saimeda32/looprail/blob/main/LICENSE" target="_blank" rel="noopener">License</a>
  </nav>
</footer>
<script>
(function () {
  var showAllRuns = false;
  var STATUS_CLASS = { running: 'status-running', verified: 'status-verified', halted: 'status-halted', canceled: 'status-canceled', parked: 'status-parked', stale: 'status-stale' };

  function el(tag, className, text) {
    var e = document.createElement(tag);
    if (className) e.className = className;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  function formatTokens(n) {
    return n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n);
  }

  // Mirrors formatTokens' placement/style: a small ES5 pure formatter, no
  // DOM access, reused by both the per-tile reading and the aggregate strip
  // so the two surfaces can never drift into showing different units.
  function formatDuration(ms) {
    var totalSec = Math.max(0, Math.round(ms / 1000));
    var h = Math.floor(totalSec / 3600);
    var m = Math.floor((totalSec % 3600) / 60);
    var s = totalSec % 60;
    if (h > 0) return h + 'h ' + m + 'm';
    if (m > 0) return m + 'm ' + s + 's';
    return s + 's';
  }

  // Anchored on the server-written startedAt/lastEventAt timestamps already
  // carried on every RunListEntry, never on a raw unanchored client clock. A
  // finished run's figure (lastEventAt - startedAt) is fully
  // server-timestamped and therefore skew-free; a running run's figure
  // (Date.now() - startedAt) only has sub-second-scale client/server skew,
  // immaterial for a live ticking counter re-anchored on every render.
  function elapsedMs(run) {
    if (!run.startedAt) return null;
    var end = run.status === 'running' ? Date.now() : (run.lastEventAt || run.startedAt);
    return Math.max(0, end - run.startedAt);
  }

  function runCard(run) {
    var a = el('a', 'run-card rail-' + (run.awaitingGate ? 'gate' : (run.status || 'running')));
    a.href = '/run/' + run.workspaceHash + '/' + run.runId + '/';
    var top = el('div', 'top');
    top.appendChild(el('span', 'name', run.name || run.runId));
    top.appendChild(run.awaitingGate
      ? el('span', 'status-pill status-gate', 'needs you \u00b7 gate')
      : el('span', 'status-pill ' + (STATUS_CLASS[run.status] || 'status-running'), run.status));
    a.appendChild(top);
    if (run.reason && (run.status === 'halted' || run.status === 'canceled' || run.status === 'parked')) {
      var reasonEl = el('div', 'reason reason-' + run.status, run.reason);
      reasonEl.title = run.reason; // MC-4: the clamp hides the tail; hover reveals it
      a.appendChild(reasonEl);
    }
    if (run.goal) a.appendChild(el('div', 'goal', run.goal));
    if (run.agents.length) a.appendChild(el('div', 'agents', run.agents.join(', ')));
    // A fixed four-slot labeled grid - the previous unlabeled flex-wrap
    // line broke differently on every card (one row here, two rows there,
    // figures changing meaning by position), which made the whole board
    // read as random. Same slots, same order, every card; a missing value
    // is a dash, never a collapsed cell.
    var stats = el('div', 'stats');
    function stat(label, valueHtml, extraClass, valueId) {
      var cell = el('div', 'stat' + (extraClass ? ' ' + extraClass : ''));
      cell.appendChild(el('span', 'stat-label', label));
      var v = el('span', 'stat-value');
      v.innerHTML = valueHtml;
      if (valueId) v.id = valueId;
      cell.appendChild(v);
      return cell;
    }
    stats.appendChild(stat('iter', String(run.iteration)));
    var costHtml;
    // Adapters that can't report a real dollar figure (copilot-cli, codex,
    // aider) leave costUsd at 0 forever - a bare "$0.00" is misleading when
    // the run plainly spent tokens. Promote the estimate (with ~) when it
    // is all there is; real cost stays authoritative otherwise.
    if (run.costUsd > 0) {
      costHtml = '$' + run.costUsd.toFixed(2);
    } else if (run.estimatedCostUsd > 0) {
      costHtml = '~$' + run.estimatedCostUsd.toFixed(2);
    } else {
      costHtml = '$0.00';
    }
    stats.appendChild(stat('cost', costHtml));
    stats.appendChild(stat('tokens', typeof run.tokens === 'number' ? formatTokens(run.tokens) : '\u2013'));
    var wallMs = elapsedMs(run);
    if (wallMs !== null) {
      var timeHtml = formatDuration(wallMs)
        + (typeof run.maxWallMinutes === 'number' ? '<span class="of"> / ' + run.maxWallMinutes + 'm</span>' : '');
      var over = typeof run.maxWallMinutes === 'number' && wallMs / 60000 > run.maxWallMinutes;
      stats.appendChild(stat('time', timeHtml, over ? 'wall-over' : undefined,
        'wall-' + run.workspaceHash + '-' + run.runId));
    } else {
      stats.appendChild(stat('time', '\u2013'));
    }
    a.appendChild(stats);
    var footer = el('div', 'card-footer');
    footer.appendChild(el('span', 'ws', run.workspaceName));
    if (run.lastEventAt) footer.appendChild(el('span', 'when', timeAgoLabel(run.lastEventAt)));
    a.appendChild(footer);
    return a;
  }

  // Client-side only: every run already carries its own real lastEventAt
  // from the server, so narrowing which ones are visible is a display
  // filter, not a re-derivation of status/cost/agents (the thing this
  // client is deliberately never supposed to compute itself).
  var RANGES = [
    { key: '24h', label: '24h', ms: 24 * 60 * 60 * 1000 },
    { key: '7d', label: '7d', ms: 7 * 24 * 60 * 60 * 1000 },
    { key: '30d', label: '30d', ms: 30 * 24 * 60 * 60 * 1000 },
    { key: 'all', label: 'All', ms: null },
  ];
  var selectedRange = 'all';
  var lastRuns = [];

  function filterByRange(runs) {
    var range = null;
    for (var i = 0; i < RANGES.length; i++) if (RANGES[i].key === selectedRange) range = RANGES[i];
    if (!range || range.ms === null) return runs;
    var cutoff = Date.now() - range.ms;
    return runs.filter(function (r) { return !r.lastEventAt || r.lastEventAt >= cutoff; });
  }

  function renderRangePicker() {
    var picker = document.getElementById('range-picker');
    picker.innerHTML = '';
    RANGES.forEach(function (range) {
      var btn = el('button', 'range-btn' + (range.key === selectedRange ? ' active' : ''), range.label);
      btn.type = 'button';
      btn.addEventListener('click', function () {
        selectedRange = range.key;
        renderRuns(lastRuns);
      });
      picker.appendChild(btn);
    });
  }

  function renderUsage(runs) {
    var workspaces = {};
    var totalCost = 0, totalEstimatedCost = 0, totalTokens = 0, running = 0, totalWallMs = 0;
    runs.forEach(function (r) {
      workspaces[r.workspaceName] = true;
      totalCost += r.costUsd || 0;
      totalEstimatedCost += r.estimatedCostUsd || 0;
      totalTokens += r.tokens || 0;
      if (r.status === 'running') running += 1;
      var wallMs = elapsedMs(r);
      if (wallMs !== null) totalWallMs += wallMs;
    });
    document.getElementById('usage-workspaces').textContent = String(Object.keys(workspaces).length);
    document.getElementById('usage-runs').textContent = String(runs.length);
    document.getElementById('usage-running').textContent = String(running);
    // Deliberately ONE combined figure here, unlike the per-tile cost (which
    // keeps real vs estimated visually distinct - see runCard above): this
    // top-line number answers "how much have I actually spent across
    // everything", and a real-cost run sitting next to an estimate-only run
    // must not silently under-report the total just because the two figures
    // come from different sources. Per-tile/per-workspace breakdowns are
    // exactly where the real-vs-estimated distinction still matters and stay
    // separate.
    // the ~ prefix appears whenever any part of the figure is estimated -
    // a bare "$14.34" where most is token-derived estimate reads as billed
    // truth (audit MC-5)
    document.getElementById('usage-cost').textContent =
      (totalEstimatedCost > 0 ? '~$' : '$') + (totalCost + totalEstimatedCost).toFixed(2);
    document.getElementById('usage-tokens').textContent = formatTokens(totalTokens);
    // Plain reading, no meter - there is no single max_wall_minutes to be
    // proportional against once runs from different loopfiles (each with
    // its own budget, or none) are summed together.
    document.getElementById('usage-wall').textContent = formatDuration(totalWallMs);
  }

  function renderRuns(runs) {
    lastRuns = runs;
    renderRangePicker();
    var visible = filterByRange(runs);
    var grid = document.getElementById('grid');
    var empty = document.getElementById('empty-state');
    document.getElementById('run-count').textContent = visible.length + ' run' + (visible.length === 1 ? '' : 's');
    renderUsage(visible);
    grid.innerHTML = '';
    if (runs.length === 0) {
      empty.style.display = 'block';
      empty.textContent = 'no runs yet - register a workspace with looprail workspace add, or just run looprail run in a project (it registers itself), then start a loop.';
      return;
    }
    if (visible.length === 0) {
      empty.style.display = 'block';
      empty.textContent = 'no runs in the last ' + selectedRange + ' - widen the range above to see older ones.';
      return;
    }
    empty.style.display = 'none';
    // Three boards, in attention order (audit MC-1/MC-6): Needs you (a
    // live gate, a parked run), then Running, then capped History - the
    // present must never drown under fifty uniform finished tiles.
    var needs = visible.filter(function (r) { return r.awaitingGate || r.status === 'parked'; });
    var runningNow = visible.filter(function (r) { return !r.awaitingGate && r.status === 'running'; });
    var rest = visible.filter(function (r) {
      return !(r.awaitingGate || r.status === 'parked' || r.status === 'running');
    });
    var needsHead = document.getElementById('needs-head');
    var needsGrid = document.getElementById('needs-grid');
    needsGrid.innerHTML = '';
    needsHead.style.display = needs.length ? 'flex' : 'none';
    needsHead.textContent = needs.length ? 'Needs you (' + needs.length + ')' : '';
    needs.forEach(function (r) { needsGrid.appendChild(runCard(r)); });
    var runningHead = document.getElementById('running-head');
    var runningGrid = document.getElementById('running-grid');
    runningGrid.innerHTML = '';
    runningHead.style.display = runningNow.length ? 'flex' : 'none';
    runningHead.textContent = runningNow.length ? 'Running (' + runningNow.length + ')' : '';
    runningNow.forEach(function (r) { runningGrid.appendChild(runCard(r)); });
    var historyHead = document.getElementById('history-head');
    historyHead.style.display = rest.length ? 'flex' : 'none';
    historyHead.textContent = rest.length ? 'History (' + rest.length + ')' : '';
    var CAP = 8;
    var shown = showAllRuns ? rest : rest.slice(0, CAP);
    shown.forEach(function (r) { grid.appendChild(runCard(r)); });
    if (rest.length > CAP) {
      var toggle = el('button', 'show-all-btn',
        showAllRuns ? 'Show fewer' : 'Show all ' + rest.length + ' runs');
      toggle.type = 'button';
      toggle.addEventListener('click', function () {
        showAllRuns = !showAllRuns;
        renderRuns(lastRuns);
      });
      grid.appendChild(toggle);
    }
  }

  function timeAgoLabel(ts) {
    var m = Math.max(0, Math.round((Date.now() - ts) / 60000));
    if (m < 1) return 'just now';
    if (m < 60) return m + 'm ago';
    if (m < 60 * 24) return Math.round(m / 60) + 'h ago';
    return Math.round(m / (60 * 24)) + 'd ago';
  }

  function minutesAgo(ts) {
    var diffMs = Date.now() - ts;
    return Math.max(0, Math.round(diffMs / 60000));
  }

  function sessionCard(session) {
    var div = el('div', 'session-card');
    div.appendChild(el('span', 'session-badge tool-' + (session.tool || 'claude-code'), session.tool || 'claude-code'));
    div.appendChild(el('div', 'workspace', session.workspaceName));
    div.appendChild(el('div', 'session-id', session.sessionId.length > 8 ? session.sessionId.slice(0, 8) + '\u2026' : session.sessionId));
    div.appendChild(el('div', 'meta', 'active ' + minutesAgo(session.lastActiveAt) + 'm ago'));
    // The one useful click for an external session looprail doesn't own:
    // copy the tool's own resume command to pick it up in a terminal.
    if (session.resumeCommand) {
      div.title = 'click to copy: ' + session.resumeCommand;
      div.style.cursor = 'pointer';
      div.addEventListener('click', function () {
        var done = function () {
          var meta = div.querySelector('.meta');
          if (meta) { meta.textContent = 'copied: ' + session.resumeCommand; }
        };
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(session.resumeCommand).then(done, done);
        } else { done(); }
      });
    }
    return div;
  }

  function renderSessions(sessions) {
    var section = document.getElementById('sessions-section');
    var grid = document.getElementById('sessions-grid');
    grid.innerHTML = '';
    if (!sessions || sessions.length === 0) {
      section.style.display = 'none';
      return;
    }
    document.getElementById('sessions-heading').textContent = 'Recent agent activity (' + sessions.length + ')';
    section.style.display = 'block';
    sessions.forEach(function (s) { grid.appendChild(sessionCard(s)); });
  }

  function renderAll(data) {
    renderRuns(data.runs || []);
    renderSessions(data.sessions || []);
  }

  function refresh() {
    fetch('/api/runs').then(function (r) { return r.json(); }).then(renderAll).catch(function (err) {
      console.error('failed to refresh mission control', err);
    });
  }

  // Ticks the wall-time readings once per second from the last rendered
  // runs (lastRuns, already populated by renderRuns) - no fetch/SSE round
  // trip per tick. Mirrors runCard's/renderUsage's own wall-time markup so
  // a running run's tile and the aggregate both keep advancing between SSE
  // frames, and stop advancing the instant a run is no longer 'running'
  // (elapsedMs then returns its fixed lastEventAt - startedAt figure).
  function tickWall() {
    var visible = filterByRange(lastRuns);
    var totalWallMs = 0;
    visible.forEach(function (r) {
      var wallMs = elapsedMs(r);
      if (wallMs === null) return;
      totalWallMs += wallMs;
      if (r.status !== 'running') return;
      var wallEl = document.getElementById('wall-' + r.workspaceHash + '-' + r.runId);
      if (!wallEl) return;
      if (typeof r.maxWallMinutes === 'number') {
        var wallMinutes = wallMs / 60000;
        var overBudget = wallMinutes > r.maxWallMinutes;
        wallEl.className = 'num' + (overBudget ? ' wall-over' : '');
        wallEl.innerHTML = '<b>' + formatDuration(wallMs) + '</b> / ' + r.maxWallMinutes + 'm';
      } else {
        wallEl.innerHTML = '<b>' + formatDuration(wallMs) + '</b>';
      }
    });
    var usageWallEl = document.getElementById('usage-wall');
    if (usageWallEl) usageWallEl.textContent = formatDuration(totalWallMs);
  }

  refresh();
  var es = new EventSource('/events');
  es.onmessage = function (e) { renderAll(JSON.parse(e.data)); };
  setInterval(tickWall, 1000);
})();
</script>
</body>
</html>`
}
