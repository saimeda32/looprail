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
    padding-bottom: 20px; border-bottom: 1px solid var(--line); margin-bottom: 24px; flex-wrap: wrap;
  }
  .wordmark { font-family: var(--mono); font-size: 14px; font-weight: 600; letter-spacing: 0.02em; display: flex; align-items: center; gap: 9px; }
  .wordmark .dot { width: 7px; height: 7px; border-radius: 1px; background: var(--signal); box-shadow: 0 0 8px 1px rgba(232,196,104,0.55); animation: pulse-dot 2.4s ease-in-out infinite; }
  #run-count { font: 12px var(--mono); color: var(--ink-dim); }

  .usage-strip { display: flex; align-items: center; justify-content: space-between; gap: 28px; flex-wrap: wrap; padding: 14px 18px; margin-bottom: 24px; border: 1px solid var(--line); border-radius: 3px; background: var(--panel); }
  .usage-figures { display: flex; gap: 28px; flex-wrap: wrap; }
  .usage-item { display: flex; flex-direction: column; gap: 2px; }
  .usage-item .label { font: 600 10px var(--sans); letter-spacing: 0.1em; text-transform: uppercase; color: var(--ink-dim); }
  .usage-item .value { font: 15px var(--mono); font-variant-numeric: tabular-nums; color: var(--ink); }

  .range-picker { display: flex; gap: 4px; }
  .range-btn { font: 11px var(--mono); padding: 5px 10px; border-radius: 3px; border: 1px solid var(--line); background: var(--panel-raised); color: var(--ink-dim); cursor: pointer; }
  .range-btn:hover { color: var(--ink); }
  .range-btn.active { color: var(--signal); border-color: rgba(232,196,104,0.4); background: rgba(232,196,104,0.1); }

  .section-head { display: flex; align-items: center; justify-content: space-between; margin: 32px 0 12px; gap: 16px; flex-wrap: wrap; }
  .section-head h2 { font-family: var(--sans); font-size: 12px; font-weight: 600; letter-spacing: 0.1em; text-transform: uppercase; color: var(--ink-dim); margin: 0; }

  main { }
  #grid {
    display: grid; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); gap: 10px;
  }
  .run-card {
    display: block; padding: 14px 16px; border-radius: 3px; background: var(--panel);
    border: 1px solid var(--line); text-decoration: none; color: inherit; transition: border-color 0.15s ease;
  }
  .run-card:hover, .run-card:focus-visible { border-color: var(--line-bright); }
  .run-card .top { display: flex; align-items: center; justify-content: space-between; margin-bottom: 3px; gap: 8px; }
  .run-card .name { font-size: 13.5px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .run-card .goal {
    font-size: 11.5px; color: var(--ink-dim); line-height: 1.4; margin-bottom: 8px;
    display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
  }
  .run-card .workspace { font: 10.5px var(--mono); color: var(--ink-faint); margin-bottom: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
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
  @keyframes pulse-dot { 50% { opacity: 0.35; } }
  .run-card .agents { font-size: 11.5px; color: var(--ink-dim); margin-bottom: 10px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .run-card .stats { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
  .run-card .stats .num { font: 11.5px var(--mono); font-variant-numeric: tabular-nums; color: var(--ink-dim); }
  .run-card .stats .num b { color: var(--ink); font-weight: 500; }
  .run-card .updated { font: 10.5px var(--mono); color: var(--ink-faint); margin-top: 8px; }
  #empty-state {
    padding: 60px 20px; text-align: center; color: var(--ink-dim); max-width: 520px; margin: 0 auto;
  }
  #sessions-section { margin-top: 32px; padding-top: 20px; border-top: 1px solid var(--line); }
  #sessions-section h2 {
    font-size: 12px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--ink-dim); margin: 0 0 10px;
  }
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
  .session-card .meta { font: 11px var(--mono); color: var(--ink-faint); }
  @media (prefers-reduced-motion: reduce) {
    .status-running::before { animation: none !important; }
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
    </div>
    <div class="range-picker" id="range-picker"></div>
  </div>
  <main>
    <div id="empty-state" style="display:none"></div>
    <div id="grid"></div>
    <section id="sessions-section" style="display:none">
      <h2 id="sessions-heading">Recent Claude Code activity</h2>
      <div id="sessions-grid"></div>
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
  var STATUS_CLASS = { running: 'status-running', verified: 'status-verified', halted: 'status-halted', canceled: 'status-canceled' };

  function el(tag, className, text) {
    var e = document.createElement(tag);
    if (className) e.className = className;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  function formatTokens(n) {
    return n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n);
  }

  function runCard(run) {
    var a = el('a', 'run-card');
    a.href = '/run/' + run.workspaceHash + '/' + run.runId + '/';
    var top = el('div', 'top');
    top.appendChild(el('span', 'name', run.name || run.runId));
    top.appendChild(el('span', 'status-pill ' + (STATUS_CLASS[run.status] || 'status-running'), run.status));
    a.appendChild(top);
    if (run.goal) a.appendChild(el('div', 'goal', run.goal));
    a.appendChild(el('div', 'workspace', run.workspaceName));
    a.appendChild(el('div', 'agents', run.agents.length ? run.agents.join(', ') : 'no agents recorded'));
    var stats = el('div', 'stats');
    var iter = el('span', 'num');
    iter.innerHTML = 'iter <b>' + run.iteration + '</b>';
    stats.appendChild(iter);
    var cost = el('span', 'num');
    cost.innerHTML = '$<b>' + run.costUsd.toFixed(2) + '</b>';
    stats.appendChild(cost);
    if (typeof run.tokens === 'number') {
      var tok = el('span', 'num');
      tok.innerHTML = '<b>' + formatTokens(run.tokens) + '</b> tok';
      stats.appendChild(tok);
    }
    a.appendChild(stats);
    if (run.lastEventAt) {
      a.appendChild(el('div', 'updated', 'updated ' + new Date(run.lastEventAt).toLocaleString()));
    }
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
    var totalCost = 0, totalTokens = 0, running = 0;
    runs.forEach(function (r) {
      workspaces[r.workspaceName] = true;
      totalCost += r.costUsd || 0;
      totalTokens += r.tokens || 0;
      if (r.status === 'running') running += 1;
    });
    document.getElementById('usage-workspaces').textContent = String(Object.keys(workspaces).length);
    document.getElementById('usage-runs').textContent = String(runs.length);
    document.getElementById('usage-running').textContent = String(running);
    document.getElementById('usage-cost').textContent = '$' + totalCost.toFixed(2);
    document.getElementById('usage-tokens').textContent = formatTokens(totalTokens);
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
    visible.forEach(function (r) { grid.appendChild(runCard(r)); });
  }

  function minutesAgo(ts) {
    var diffMs = Date.now() - ts;
    return Math.max(0, Math.round(diffMs / 60000));
  }

  function sessionCard(session) {
    var div = el('div', 'session-card');
    div.appendChild(el('span', 'session-badge', 'session'));
    div.appendChild(el('div', 'workspace', session.workspaceName));
    div.appendChild(el('div', 'session-id', session.sessionId.length > 8 ? session.sessionId.slice(0, 8) + '…' : session.sessionId));
    div.appendChild(el('div', 'meta', 'active ' + minutesAgo(session.lastActiveAt) + 'm ago'));
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
    document.getElementById('sessions-heading').textContent = 'Recent Claude Code activity (' + sessions.length + ')';
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

  refresh();
  var es = new EventSource('/events');
  es.onmessage = function (e) { renderAll(JSON.parse(e.data)); };
})();
</script>
</body>
</html>`
}
