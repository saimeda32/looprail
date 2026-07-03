// Self-contained dashboard page: inline CSS, inline vanilla-JS client, inline
// SVG DAG rendering. No external request of any kind — see Global Constraints.
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
  .status-pill {
    padding: 3px 10px; border-radius: 3px; font: 600 10.5px/1.4 var(--mono);
    text-transform: uppercase; letter-spacing: 0.08em;
    background: var(--panel-raised); color: var(--ink-dim);
    display: inline-flex; align-items: center; gap: 6px;
  }
  .status-pill::before {
    content: ''; width: 6px; height: 6px; border-radius: 50%; background: currentColor; display: inline-block;
  }
  .status-running { color: var(--signal); }
  .status-running::before { animation: pulse-dot 1.2s ease-in-out infinite; }
  .status-verified { color: var(--pass); }
  .status-halted { color: var(--warn); }
  main { display: grid; grid-template-columns: 1fr 360px; gap: 0; height: calc(100vh - 53px); }
  #canvas-wrap { position: relative; overflow: auto; border-right: 1px solid var(--line); }
  #dag { display: block; }
  .node-box { stroke-width: 2; cursor: pointer; }
  .node-pending { fill: var(--panel-raised); stroke: var(--line-bright); }
  .node-running { fill: var(--panel-raised); stroke: var(--signal); }
  .node-pass, .node-done { fill: var(--panel-raised); stroke: var(--pass); }
  .node-fail, .node-error { fill: var(--panel-raised); stroke: var(--fail); }
  .node-stall { fill: var(--panel-raised); stroke: var(--warn); }
  .node-skipped { fill: var(--panel-raised); stroke: var(--line); stroke-dasharray: 4 3; }
  .edge { stroke: var(--line-bright); stroke-width: 1.5; fill: none; marker-end: url(#arrow); }
  .arrow-head { fill: var(--line-bright); }
  .edge-live {
    stroke: var(--signal-dim); stroke-width: 1.5; fill: none; marker-end: url(#arrow);
    stroke-dasharray: 4 5; animation: flow 1.1s linear infinite;
  }
  @keyframes flow { to { stroke-dashoffset: -18; } }
  @keyframes pulse-dot { 50% { opacity: 0.35; } }
  .node-label { fill: var(--ink); font: 12px var(--mono); pointer-events: none; }
  aside { padding: 16px; overflow: auto; background: var(--void); }
  section { margin-bottom: 20px; }
  section h2 { font-size: 12px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--ink-dim); margin: 0 0 8px; }
  .meter { background: var(--line); border-radius: 2px; height: 6px; overflow: hidden; margin-bottom: 4px; }
  .meter-fill { height: 100%; background: var(--signal-dim); }
  .meter-fill.over { background: var(--fail); }
  .meter-label { font: 12px var(--mono); font-variant-numeric: tabular-nums; color: var(--ink-dim); }
  #detail-panel {
    white-space: pre-wrap; font: 12px/1.5 var(--mono); background: var(--panel-raised);
    border: 1px solid var(--line); color: var(--ink); padding: 10px; border-radius: 4px;
    max-height: 260px; overflow: auto;
  }
  .plan-version { border-left: 2px solid var(--line-bright); padding: 4px 0 4px 10px; margin-bottom: 8px; font-size: 12px; color: var(--ink-dim); }
  .plan-version pre { white-space: pre-wrap; margin: 4px 0 0; color: var(--ink); }
  #empty-state { padding: 60px 20px; text-align: center; color: var(--ink-dim); }
  .tab-strip { display: flex; gap: 4px; flex-wrap: wrap; margin-bottom: 8px; border-bottom: 1px solid var(--line); padding-bottom: 6px; }
  .tab {
    display: inline-flex; align-items: center; gap: 5px;
    padding: 3px 8px; font: 11px var(--mono); background: var(--panel-raised); color: var(--ink-faint);
    cursor: pointer; border: none; border-bottom: 2px solid transparent; border-radius: 3px 3px 0 0;
  }
  .tab-dot {
    width: 5px; height: 5px; border-radius: 50%; background: var(--signal); display: inline-block;
    animation: pulse-dot 1.2s ease-in-out infinite;
  }
  .tab.active { color: var(--ink); border-bottom-color: var(--signal); }
  #live-output-body {
    white-space: pre-wrap; font: 12px/1.5 var(--mono); background: var(--panel-raised);
    color: var(--ink); padding: 10px; border-radius: 4px; max-height: 220px; overflow: auto; margin: 0;
  }
  .cursor {
    display: inline-block; width: 6px; height: 13px; background: var(--signal);
    vertical-align: text-bottom; margin-left: 1px; animation: blink 1s steps(2, jump-none) infinite;
  }
  @keyframes blink { 50% { opacity: 0; } }
  @media (prefers-reduced-motion: reduce) {
    .edge-live, .status-running::before, .tab-dot, .cursor { animation: none !important; }
  }
</style>
</head>
<body>
<header>
  <h1 id="run-title">looprail dashboard</h1>
  <span id="status-pill" class="status-pill status-running">running</span>
  <span id="reason" style="color:var(--ink-dim)"></span>
</header>
<main>
  <div id="canvas-wrap">
    <div id="empty-state" style="display:none">no events yet — waiting for the run to start writing its journal…</div>
    <svg id="dag" width="100%" height="100%">
      <defs>
        <marker id="arrow" markerWidth="8" markerHeight="8" refX="7" refY="3" orient="auto">
          <path class="arrow-head" d="M0,0 L7,3 L0,6 Z" />
        </marker>
      </defs>
      <g id="edges"></g>
      <g id="nodes"></g>
    </svg>
  </div>
  <aside>
    <section id="live-output-section" style="display:none">
      <h2>Live output</h2>
      <div id="live-tabs" class="tab-strip"></div>
      <pre id="live-output-body"></pre>
    </section>
    <section>
      <h2>Cost</h2>
      <div class="meter"><div id="cost-fill" class="meter-fill" style="width:0%"></div></div>
      <div id="cost-label" class="meter-label"></div>
    </section>
    <section>
      <h2>Iterations</h2>
      <div class="meter"><div id="iter-fill" class="meter-fill" style="width:0%"></div></div>
      <div id="iter-label" class="meter-label"></div>
    </section>
    <section>
      <h2>Selected node</h2>
      <div id="detail-panel">click a node in the graph to see its latest output and verdict history</div>
    </section>
    <section>
      <h2>Plan evolution</h2>
      <div id="plans"></div>
    </section>
  </aside>
</main>
<script>
(function () {
  var STATUS_CLASS = {
    pending: 'node-pending', running: 'node-running', pass: 'node-pass', done: 'node-done',
    fail: 'node-fail', error: 'node-error', stall: 'node-stall', skipped: 'node-skipped',
  };
  var selected = null;
  var selectedTab = null; // nodeId of the tab the user is viewing; null = default to the first running node

  var SVG_NS = 'http://www.w3.org/2000/svg'; // fixed XML namespace id required by createElementNS — never fetched over the network
  function el(tag, attrs, parent) {
    var e = document.createElementNS(SVG_NS, tag);
    for (var k in attrs) e.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(e);
    return e;
  }

  function findNode(list, id) {
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }

  function renderMeter(fillId, labelId, value, max, unit) {
    var fill = document.getElementById(fillId);
    var label = document.getElementById(labelId);
    if (max === undefined || max === null) {
      fill.style.width = '100%';
      fill.classList.remove('over');
      label.textContent = unit === '$' ? ('$' + value.toFixed(2) + ' spent — no budget loaded') : (value + ' iterations — no max loaded');
      return;
    }
    var pct = max > 0 ? Math.min(100, (value / max) * 100) : 100;
    fill.style.width = pct + '%';
    fill.classList.toggle('over', value > max);
    label.textContent = unit === '$'
      ? ('$' + value.toFixed(2) + ' / $' + max.toFixed(2))
      : (value + ' / ' + max);
  }

  function renderDetail(node) {
    var panel = document.getElementById('detail-panel');
    if (!node) { panel.textContent = 'click a node in the graph to see its latest output and verdict history'; return; }
    var lines = [node.id + ' (' + node.role + ') — ' + node.status];
    node.iterations.slice().reverse().forEach(function (rec) {
      lines.push('');
      lines.push('iter ' + rec.iteration + ': ' + rec.status + (rec.evidence ? ' — ' + rec.evidence : ''));
      if (rec.output) lines.push(rec.output);
    });
    panel.textContent = lines.join('\\n');
  }

  function renderPlans(plans) {
    var container = document.getElementById('plans');
    container.innerHTML = '';
    plans.forEach(function (p) {
      var div = document.createElement('div');
      div.className = 'plan-version';
      var title = document.createElement('div');
      title.textContent = (p.replan === 0 ? 'initial plan' : 'replan #' + p.replan) + ' — iter ' + p.iteration;
      var pre = document.createElement('pre');
      pre.textContent = p.output;
      div.appendChild(title);
      div.appendChild(pre);
      container.appendChild(div);
    });
  }

  function renderLiveOutput(model) {
    var section = document.getElementById('live-output-section');
    var running = model.nodes.filter(function (n) { return n.status === 'running'; });
    if (running.length === 0) { section.style.display = 'none'; selectedTab = null; return; }
    section.style.display = 'block';
    if (!selectedTab || !findNode(running, selectedTab)) {
      selectedTab = running[0].id; // default: first running node in model order — see design decision 4
    }
    var tabs = document.getElementById('live-tabs');
    tabs.innerHTML = '';
    running.forEach(function (n) {
      var tab = document.createElement('div');
      tab.className = 'tab' + (n.id === selectedTab ? ' active' : '');
      var dot = document.createElement('span');
      dot.className = 'tab-dot';
      tab.appendChild(dot);
      var label = document.createElement('span');
      label.textContent = n.role + (n.agent ? ' · ' + n.agent : '') + (n.model ? ' · ' + n.model : '');
      tab.appendChild(label);
      tab.title = n.id;
      tab.addEventListener('click', function () { selectedTab = n.id; renderLiveOutput(model); });
      tabs.appendChild(tab);
    });
    var current = findNode(running, selectedTab);
    var body = document.getElementById('live-output-body');
    body.textContent = (current && current.streamingOutput) ? current.streamingOutput : '(waiting for output...)';
    if (current && current.status === 'running') {
      var cursor = document.createElement('span');
      cursor.className = 'cursor';
      body.appendChild(cursor);
    }
    body.scrollTop = body.scrollHeight;
  }

  function render(model) {
    document.getElementById('empty-state').style.display = model.nodes.length === 0 ? 'block' : 'none';
    document.getElementById('run-title').textContent = model.name ? (model.runId + ' — ' + model.name) : 'looprail dashboard';
    var pill = document.getElementById('status-pill');
    pill.textContent = model.status;
    pill.className = 'status-pill status-' + model.status;
    document.getElementById('reason').textContent = model.reason || '';

    renderMeter('cost-fill', 'cost-label', model.totals.costUsd, model.totals.maxCostUsd, '$');
    renderMeter('iter-fill', 'iter-label', model.totals.iteration, model.totals.maxIterations, '');

    var byId = {};
    model.nodes.forEach(function (n) { byId[n.id] = n; });
    var layoutById = {};
    model.layout.forEach(function (l) { layoutById[l.id] = l; });

    var edgesG = document.getElementById('edges');
    var nodesG = document.getElementById('nodes');
    edgesG.innerHTML = '';
    nodesG.innerHTML = '';

    model.edges.forEach(function (pair) {
      var a = layoutById[pair[0]], b = layoutById[pair[1]];
      if (!a || !b) return;
      var targetNode = byId[pair[1]];
      var isLive = targetNode && targetNode.status === 'running';
      el('line', { class: isLive ? 'edge-live' : 'edge', x1: a.x + 70, y1: a.y + 20, x2: b.x, y2: b.y + 20 }, edgesG);
    });

    model.layout.forEach(function (l) {
      var node = byId[l.id];
      if (!node) return;
      var g = el('g', { transform: 'translate(' + l.x + ',' + l.y + ')' }, nodesG);
      var rect = el('rect', {
        class: 'node-box ' + (STATUS_CLASS[node.status] || 'node-pending'),
        width: 130, height: 40, rx: 3,
      }, g);
      el('text', { class: 'node-label', x: 8, y: 24 }, g).textContent = node.id;
      g.style.cursor = 'pointer';
      g.addEventListener('click', function () { selected = node.id; renderDetail(node); });
      if (selected === node.id) rect.setAttribute('stroke-width', '3');
    });

    var svg = document.getElementById('dag');
    var maxX = 0, maxY = 0;
    model.layout.forEach(function (l) { maxX = Math.max(maxX, l.x + 160); maxY = Math.max(maxY, l.y + 80); });
    svg.setAttribute('viewBox', '0 0 ' + Math.max(maxX, 400) + ' ' + Math.max(maxY, 200));

    renderPlans(model.plans);
    if (selected && byId[selected]) renderDetail(byId[selected]);
    renderLiveOutput(model);
  }

  function refresh() {
    fetch('/model').then(function (r) { return r.json(); }).then(render).catch(function (err) {
      console.error('failed to refresh dashboard model', err);
    });
  }

  refresh();
  var es = new EventSource('/events');
  es.onmessage = function () { refresh(); };
})();
</script>
</body>
</html>`
}
