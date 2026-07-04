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
  html, body { background: var(--void); height: 100%; }
  body {
    margin: 0; font: 14px/1.5 var(--sans); color: var(--ink);
    background-image:
      linear-gradient(var(--line) 1px, transparent 1px),
      linear-gradient(90deg, var(--line) 1px, transparent 1px);
    background-size: 48px 48px; background-position: -1px -1px; background-attachment: fixed;
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

  .run-panel { border: 1px solid var(--line); border-radius: 3px; background: var(--panel); overflow: hidden; }
  .run-header { display: flex; align-items: center; justify-content: space-between; padding: 14px 18px; border-bottom: 1px solid var(--line); flex-wrap: wrap; gap: 12px; }
  .run-title { display: flex; align-items: baseline; gap: 10px; min-width: 0; }
  .run-title .name { font-size: 14px; font-weight: 600; }
  .run-title .id { font: 11px var(--mono); color: var(--ink-faint); }
  #reason { font-size: 12px; color: var(--ink-dim); }

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

  .gauges { display: flex; align-items: center; gap: 26px; padding: 11px 18px; border-bottom: 1px solid var(--line); flex-wrap: wrap; }
  .gauge { display: flex; align-items: center; gap: 9px; }
  .gauge .label { font: 600 10.5px var(--sans); letter-spacing: 0.1em; text-transform: uppercase; color: var(--ink-dim); white-space: nowrap; }
  .gauge .reading { font: 12px var(--mono); font-variant-numeric: tabular-nums; color: var(--ink); white-space: nowrap; }
  .gauge .reading .of { color: var(--ink-faint); }
  .meter { width: 84px; height: 5px; background: var(--line); border-radius: 2px; overflow: hidden; }
  .meter > span { display: block; height: 100%; background: var(--signal-dim); }
  .meter > span.over { background: var(--fail); }

  .run-body { display: grid; grid-template-columns: 1fr 360px; }
  @media (max-width: 800px) { .run-body { grid-template-columns: 1fr; } }
  #canvas-wrap { position: relative; overflow: auto; border-right: 1px solid var(--line); padding: 16px; }
  @media (max-width: 800px) { #canvas-wrap { border-right: none; border-bottom: 1px solid var(--line); } }
  #dag { display: block; }
  .node-plate { fill: var(--panel-raised); stroke: var(--line-bright); stroke-width: 1.5; cursor: pointer; }
  .node-plate.node-running { stroke: var(--signal); }
  .node-plate.node-pass, .node-plate.node-done { stroke: var(--pass); }
  .node-plate.node-fail, .node-plate.node-error { stroke: var(--fail); }
  .node-plate.node-stall { stroke: var(--warn); }
  .node-plate.node-skipped { stroke: var(--line); stroke-dasharray: 4 3; }
  .node-label { fill: var(--ink); font: 12px var(--mono); pointer-events: none; }
  .node-sub { fill: var(--ink-faint); font: 8.5px var(--sans); letter-spacing: 0.05em; text-transform: uppercase; pointer-events: none; }
  .node-dot { pointer-events: none; }
  .node-dot.node-running { fill: var(--signal); animation: pulse-dot 1.6s ease-in-out infinite; }
  .node-dot.node-pass, .node-dot.node-done { fill: var(--pass); }
  .node-dot.node-fail, .node-dot.node-error { fill: var(--fail); }
  .node-dot.node-stall { fill: var(--warn); }
  .node-dot.node-pending, .node-dot.node-skipped { fill: var(--line-bright); }
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
  .cursor { display: inline-block; width: 6px; height: 13px; background: var(--signal); vertical-align: text-bottom; margin-left: 1px; animation: blink 1s steps(2, jump-none) infinite; }
  @keyframes blink { 50% { opacity: 0; } }
  .live-meta { padding: 10px 16px; border-top: 1px solid var(--line); display: flex; flex-direction: column; gap: 3px; }
  .live-meta .row { font-size: 11.5px; color: var(--ink-dim); }
  .live-meta .row b { color: var(--ink); font-weight: 500; }
  #live-output-section[style*="display: none"] + .agent-table-wrap { margin-top: 0; }

  .agent-table { border: 1px solid var(--line); border-radius: 3px; overflow: hidden; }
  .agent-row { display: grid; grid-template-columns: 1fr 110px 60px 90px 90px; align-items: center; padding: 9px 16px; border-bottom: 1px solid var(--line); font-size: 12.5px; background: var(--panel); gap: 8px; }
  .agent-row:last-child { border-bottom: none; }
  .agent-row.head { font: 600 10.5px var(--sans); letter-spacing: 0.08em; text-transform: uppercase; color: var(--ink-faint); background: var(--panel-raised); }
  .agent-row.total { font-weight: 600; background: var(--panel-raised); }
  .agent-row .num { text-align: right; font-variant-numeric: tabular-nums; }
  .agent-row .role { color: var(--ink-dim); }
  @media (max-width: 560px) { .agent-row { grid-template-columns: 1fr 60px 70px; } .agent-row span:nth-child(2) { display: none; } }

  #detail-panel { white-space: pre-wrap; font: 12px/1.55 var(--mono); background: var(--panel); border: 1px solid var(--line); border-radius: 3px; color: var(--ink); padding: 14px 16px; max-height: 260px; overflow: auto; }
  .plan-version { border-left: 2px solid var(--line-bright); padding: 4px 0 4px 12px; margin-bottom: 10px; font-size: 12px; color: var(--ink-dim); }
  .plan-version pre { white-space: pre-wrap; margin: 4px 0 0; color: var(--ink); font-family: var(--mono); }
  #empty-state { padding: 60px 20px; text-align: center; color: var(--ink-dim); }

  @media (prefers-reduced-motion: reduce) {
    .trace.edge-live, .status-running::before, .tab.active .tab-dot, .cursor, .node-dot.node-running, .wordmark .dot { animation: none !important; }
  }
</style>
</head>
<body>
<div class="wrap">
  <div class="masthead">
    <div class="wordmark"><span class="dot"></span> LOOPRAIL <a id="back-link" href="../../">&larr; mission control</a></div>
    <span id="status-pill" class="status-pill status-running">running</span>
  </div>

  <div id="empty-state" style="display:none">no events yet - waiting for the run to start writing its journal…</div>

  <div class="run-panel" id="run-panel">
    <div class="run-header">
      <div class="run-title">
        <span class="name" id="run-title">looprail dashboard</span>
        <span class="id" id="run-id"></span>
      </div>
      <span id="reason"></span>
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
    </div>
    <div class="run-body">
      <div id="canvas-wrap">
        <svg id="dag" width="100%" height="100%">
          <defs>
            <marker id="arrow" markerWidth="8" markerHeight="8" refX="7" refY="3" orient="auto">
              <path class="arrow-head" d="M0,0 L7,3 L0,6 Z" />
            </marker>
            <marker id="arrow-live" markerWidth="8" markerHeight="8" refX="7" refY="3" orient="auto">
              <path class="arrow-head-live" d="M0,0 L7,3 L0,6 Z" />
            </marker>
          </defs>
          <g id="edges"></g>
          <g id="nodes"></g>
        </svg>
      </div>
      <div class="live-pane">
        <section id="live-output-section" style="display:none">
          <div id="live-tabs" class="tab-strip"></div>
          <pre id="live-output-body"></pre>
          <div id="live-meta" class="live-meta"></div>
        </section>
      </div>
    </div>
  </div>

  <div class="section-head">Spend by agent</div>
  <div class="agent-table" id="agent-table"></div>

  <div class="section-head">Selected node</div>
  <div id="detail-panel">click a node in the graph to see its latest output and verdict history</div>

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
<script>
(function () {
  var STATUS_CLASS = {
    pending: 'node-pending', running: 'node-running', pass: 'node-pass', done: 'node-done',
    fail: 'node-fail', error: 'node-error', stall: 'node-stall', skipped: 'node-skipped',
  };
  var selected = null;
  var selectedTab = null; // nodeId of the tab the user is viewing; null = default to the first running node

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

  function findNode(list, id) {
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }

  function formatTokens(n) {
    return n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n);
  }

  function renderMeter(fillId, labelId, value, max, unit) {
    var fill = document.getElementById(fillId);
    var label = document.getElementById(labelId);
    if (max === undefined || max === null) {
      fill.style.width = '100%';
      fill.className = '';
      label.innerHTML = unit === '$' ? ('$' + value.toFixed(2) + '<span class="of"> no budget set</span>') : (value + '<span class="of"> no max set</span>');
      return;
    }
    var pct = max > 0 ? Math.min(100, (value / max) * 100) : 100;
    fill.style.width = pct + '%';
    fill.className = value > max ? 'over' : '';
    label.innerHTML = unit === '$'
      ? ('$' + value.toFixed(2) + '<span class="of"> / $' + max.toFixed(2) + '</span>')
      : (value + '<span class="of"> / ' + max + '</span>');
  }

  function renderDetail(node) {
    var panel = document.getElementById('detail-panel');
    if (!node) { panel.textContent = 'click a node in the graph to see its latest output and verdict history'; return; }
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

  function agentLabel(node) {
    if (!node.agent) return '(' + node.role + ')';
    return node.model ? node.agent + ' \\u00b7 ' + node.model : node.agent;
  }

  function renderAgentTable(nodes, totals) {
    var groups = {};
    var order = [];
    nodes.forEach(function (n) {
      var key = agentLabel(n);
      if (!groups[key]) { groups[key] = { label: key, roles: {}, calls: 0, tokens: 0, costUsd: 0 }; order.push(key); }
      var g = groups[key];
      g.roles[n.role] = true;
      g.calls += n.iterations.length;
      g.tokens += n.tokens;
      g.costUsd += n.costUsd;
    });
    var table = document.getElementById('agent-table');
    table.innerHTML = '';
    var head = htmlEl('div', 'agent-row head');
    ['Agent', 'Role', 'Calls', 'Tokens', 'Cost'].forEach(function (h, i) {
      head.appendChild(htmlEl('span', i > 1 ? 'num' : null, h));
    });
    table.appendChild(head);
    if (order.length === 0) {
      table.appendChild(htmlEl('div', 'agent-row', '(no agent activity yet)'));
      return;
    }
    order.forEach(function (key) {
      var g = groups[key];
      var row = htmlEl('div', 'agent-row');
      row.appendChild(htmlEl('span', null, g.label));
      row.appendChild(htmlEl('span', 'role', Object.keys(g.roles).join(', ')));
      row.appendChild(htmlEl('span', 'num', String(g.calls)));
      row.appendChild(htmlEl('span', 'num', formatTokens(g.tokens)));
      row.appendChild(htmlEl('span', 'num', '$' + g.costUsd.toFixed(3)));
      table.appendChild(row);
    });
    var total = htmlEl('div', 'agent-row total');
    total.appendChild(htmlEl('span', null, 'Total'));
    total.appendChild(htmlEl('span', null, ''));
    total.appendChild(htmlEl('span', 'num', String(nodes.reduce(function (a, n) { return a + n.iterations.length; }, 0))));
    total.appendChild(htmlEl('span', 'num', formatTokens(totals.tokens)));
    total.appendChild(htmlEl('span', 'num', '$' + totals.costUsd.toFixed(3)));
    table.appendChild(total);
  }

  function renderLiveOutput(model) {
    var section = document.getElementById('live-output-section');
    var running = model.nodes.filter(function (n) { return n.status === 'running'; });
    if (running.length === 0) { section.style.display = 'none'; selectedTab = null; return; }
    section.style.display = 'block';
    if (!selectedTab || !findNode(running, selectedTab)) {
      selectedTab = running[0].id; // default: first running node in model order - see design decision 4
    }
    var tabs = document.getElementById('live-tabs');
    tabs.innerHTML = '';
    running.forEach(function (n) {
      var tab = htmlEl('div', 'tab' + (n.id === selectedTab ? ' active' : ''));
      tab.appendChild(htmlEl('span', 'tab-dot'));
      tab.appendChild(htmlEl('span', null, n.role + (n.agent ? ' \\u00b7 ' + n.agent : '') + (n.model ? ' \\u00b7 ' + n.model : '')));
      tab.title = n.id;
      tab.addEventListener('click', function () { selectedTab = n.id; renderLiveOutput(model); });
      tabs.appendChild(tab);
    });
    var current = findNode(running, selectedTab);
    var body = document.getElementById('live-output-body');
    body.textContent = (current && current.streamingOutput) ? current.streamingOutput : '(waiting for output...)';
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
      var r2 = htmlEl('div', 'row');
      r2.textContent = formatTokens(current.tokens) + ' tokens \\u00b7 $' + current.costUsd.toFixed(3) + ' so far';
      meta.appendChild(r2);
    }
  }

  function render(model) {
    document.getElementById('empty-state').style.display = model.nodes.length === 0 ? 'block' : 'none';
    document.getElementById('run-panel').style.display = model.nodes.length === 0 ? 'none' : 'block';
    document.getElementById('run-title').textContent = model.name || 'looprail dashboard';
    document.getElementById('run-id').textContent = model.runId ? 'RUN ' + model.runId : '';
    var pill = document.getElementById('status-pill');
    pill.textContent = model.status;
    pill.className = 'status-pill status-' + model.status;
    document.getElementById('reason').textContent = model.reason || '';

    var back = document.getElementById('back-link');
    back.style.display = location.pathname.indexOf('/run/') === 0 ? 'inline' : 'none';

    renderMeter('cost-fill', 'cost-label', model.totals.costUsd, model.totals.maxCostUsd, '$');
    renderMeter('iter-fill', 'iter-label', model.totals.iteration, model.totals.maxIterations, '');
    document.getElementById('tokens-label').textContent = formatTokens(model.totals.tokens);
    document.getElementById('replans-label').textContent = String(model.totals.replans);

    var byId = {};
    model.nodes.forEach(function (n) { byId[n.id] = n; });
    var layoutById = {};
    model.layout.forEach(function (l) { layoutById[l.id] = l; });

    var edgesG = document.getElementById('edges');
    var nodesG = document.getElementById('nodes');
    edgesG.innerHTML = '';
    nodesG.innerHTML = '';

    var BOX_W = 148, BOX_H = 44;
    model.edges.forEach(function (pair) {
      var a = layoutById[pair[0]], b = layoutById[pair[1]];
      if (!a || !b) return;
      var targetNode = byId[pair[1]];
      var isLive = targetNode && targetNode.status === 'running';
      var x1 = a.x + BOX_W, y1 = a.y + BOX_H / 2, x2 = b.x, y2 = b.y + BOX_H / 2;
      var midX = (x1 + x2) / 2;
      var d = 'M ' + x1 + ' ' + y1 + ' L ' + midX + ' ' + y1 + ' L ' + midX + ' ' + y2 + ' L ' + x2 + ' ' + y2;
      el('path', { class: 'trace' + (isLive ? ' edge-live' : ''), d: d }, edgesG);
    });

    model.layout.forEach(function (l) {
      var node = byId[l.id];
      if (!node) return;
      var statusClass = STATUS_CLASS[node.status] || 'node-pending';
      var g = el('g', { transform: 'translate(' + l.x + ',' + l.y + ')' }, nodesG);
      var rect = el('rect', { class: 'node-plate ' + statusClass, width: BOX_W, height: BOX_H, rx: 3 }, g);
      el('circle', { class: 'node-dot ' + statusClass, cx: 10, cy: BOX_H / 2, r: 3 }, g);
      el('text', { class: 'node-label', x: 20, y: 18 }, g).textContent = node.id;
      el('text', { class: 'node-sub', x: 20, y: 33 }, g).textContent =
        node.role + (node.agent ? ' \\u00b7 ' + node.agent : '') + (node.model ? ' \\u00b7 ' + node.model : '');
      g.addEventListener('click', function () { selected = node.id; renderDetail(node); });
      if (selected === node.id) rect.setAttribute('stroke-width', '2.5');
    });

    var svg = document.getElementById('dag');
    var maxX = 0, maxY = 0;
    model.layout.forEach(function (l) { maxX = Math.max(maxX, l.x + BOX_W + 40); maxY = Math.max(maxY, l.y + BOX_H + 40); });
    svg.setAttribute('viewBox', '0 0 ' + Math.max(maxX, 400) + ' ' + Math.max(maxY, 200));
    svg.setAttribute('height', Math.max(maxY, 200));

    renderAgentTable(model.nodes, model.totals);
    renderPlans(model.plans);
    if (selected && byId[selected]) renderDetail(byId[selected]);
    renderLiveOutput(model);
  }

  function refresh() {
    // Relative, not '/model': this same page is served both standalone at
    // '/' (looprail ui) and nested at '/run/<hash>/<runId>/' (mission
    // control), and a leading slash would always hit the site root's route,
    // 404ing under mission control. The server enforces a trailing slash on
    // this page's own URL (see startMissionControlServer) specifically so
    // this relative resolution is reliable either way.
    fetch('model').then(function (r) { return r.json(); }).then(render).catch(function (err) {
      console.error('failed to refresh dashboard model', err);
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
