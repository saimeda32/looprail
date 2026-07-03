// Self-contained mission-control page: a card grid across every registered
// workspace's runs, plus a secondary section for raw Claude Code sessions.
// Same house style as page.ts — inline CSS/JS, no external requests, no
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
  body {
    margin: 0; font: 14px/1.5 var(--sans);
    background: var(--void); color: var(--ink);
  }
  header {
    padding: 12px 20px; border-bottom: 1px solid var(--line); background: var(--panel);
    display: flex; align-items: center; gap: 16px; flex-wrap: wrap;
  }
  header h1 {
    font-size: 13px; margin: 0; font-weight: 600; letter-spacing: 0.02em;
    text-transform: uppercase; color: var(--ink);
  }
  #run-count { font: 12px var(--mono); color: var(--ink-dim); }
  main { padding: 20px; }
  #grid {
    display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 12px;
  }
  .run-card {
    display: block; padding: 14px; border-radius: 4px; background: var(--panel);
    border: 1px solid var(--line); text-decoration: none; color: inherit;
  }
  .run-card:hover { border-color: var(--line-bright); }
  .run-card .workspace { font-size: 12px; color: var(--ink-dim); margin-bottom: 4px; }
  .run-card .run-id { font: 600 13px var(--mono); color: var(--ink); margin-bottom: 8px; }
  .status-pill {
    padding: 3px 10px; border-radius: 3px; font: 600 10.5px/1.4 var(--mono);
    text-transform: uppercase; letter-spacing: 0.08em;
    background: var(--panel-raised); color: var(--ink-dim);
    display: inline-flex; align-items: center; gap: 6px; margin-bottom: 8px;
  }
  .status-pill::before {
    content: ''; width: 6px; height: 6px; border-radius: 50%; background: currentColor; display: inline-block;
  }
  .status-running { color: var(--signal); }
  .status-running::before { animation: pulse-dot 1.2s ease-in-out infinite; }
  .status-verified { color: var(--pass); }
  .status-halted { color: var(--warn); }
  @keyframes pulse-dot { 50% { opacity: 0.35; } }
  .run-card .agents { font-size: 12px; color: var(--ink); margin-bottom: 4px; }
  .run-card .meta { font: 11px var(--mono); color: var(--ink-dim); }
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
<header>
  <h1>looprail mission control</h1>
  <span id="run-count"></span>
</header>
<main>
  <div id="empty-state" style="display:none"></div>
  <div id="grid"></div>
  <section id="sessions-section" style="display:none">
    <h2 id="sessions-heading">Recent Claude Code activity</h2>
    <div id="sessions-grid"></div>
  </section>
</main>
<script>
(function () {
  var STATUS_CLASS = { running: 'status-running', verified: 'status-verified', halted: 'status-halted' };

  function el(tag, className, text) {
    var e = document.createElement(tag);
    if (className) e.className = className;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  function runCard(run) {
    var a = el('a', 'run-card');
    a.href = '/run/' + run.workspaceHash + '/' + run.runId + '/';
    a.appendChild(el('div', 'workspace', run.workspaceName));
    a.appendChild(el('div', 'run-id', run.runId));
    a.appendChild(el('span', 'status-pill ' + (STATUS_CLASS[run.status] || 'status-running'), run.status));
    a.appendChild(el('div', 'agents', run.agents.length ? run.agents.join(', ') : 'no agents recorded'));
    a.appendChild(el('div', 'meta', 'iter ' + run.iteration + ' · $' + run.costUsd.toFixed(2)));
    if (run.lastEventAt) {
      a.appendChild(el('div', 'meta', 'updated ' + new Date(run.lastEventAt).toLocaleString()));
    }
    return a;
  }

  function renderRuns(runs) {
    var grid = document.getElementById('grid');
    var empty = document.getElementById('empty-state');
    document.getElementById('run-count').textContent = runs.length + ' run' + (runs.length === 1 ? '' : 's');
    grid.innerHTML = '';
    if (runs.length === 0) {
      empty.style.display = 'block';
      empty.textContent = 'no runs yet — register a workspace with looprail workspace add, or just run looprail run in a project (it registers itself), then start a loop.';
      return;
    }
    empty.style.display = 'none';
    runs.forEach(function (r) { grid.appendChild(runCard(r)); });
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
