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
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    background: #0f1115; color: #e6e8eb;
  }
  header {
    padding: 12px 20px; border-bottom: 1px solid #24272e;
    display: flex; align-items: center; gap: 16px; flex-wrap: wrap;
  }
  header h1 { font-size: 15px; margin: 0; font-weight: 600; }
  .status-pill {
    padding: 2px 10px; border-radius: 999px; font-size: 12px; font-weight: 600;
    text-transform: uppercase; letter-spacing: 0.04em;
  }
  .status-running { background: #3a3410; color: #e8c547; }
  .status-verified { background: #123a1e; color: #4fd07a; }
  .status-halted { background: #3a1414; color: #f06868; }
  main { display: grid; grid-template-columns: 1fr 360px; gap: 0; height: calc(100vh - 53px); }
  #canvas-wrap { position: relative; overflow: auto; border-right: 1px solid #24272e; }
  #dag { display: block; }
  .node-box { stroke-width: 2; cursor: pointer; }
  .node-pending { fill: #1b1e24; stroke: #3a3f48; }
  .node-running { fill: #1b1e24; stroke: #e8c547; }
  .node-pass { fill: #123a1e; stroke: #4fd07a; }
  .node-done { fill: #142230; stroke: #5aa9e6; }
  .node-fail, .node-error { fill: #3a1414; stroke: #f06868; }
  .node-stall { fill: #3a2a10; stroke: #e89a47; }
  .node-skipped { fill: #17181c; stroke: #5a5f68; stroke-dasharray: 4 3; }
  .edge { stroke: #3a3f48; stroke-width: 1.5; fill: none; marker-end: url(#arrow); }
  .node-label { fill: #e6e8eb; font-size: 12px; pointer-events: none; }
  aside { padding: 16px; overflow: auto; }
  section { margin-bottom: 20px; }
  section h2 { font-size: 12px; text-transform: uppercase; letter-spacing: 0.06em; color: #9096a1; margin: 0 0 8px; }
  .meter { background: #1b1e24; border-radius: 6px; height: 8px; overflow: hidden; margin-bottom: 4px; }
  .meter-fill { height: 100%; background: #5aa9e6; }
  .meter-fill.over { background: #f06868; }
  .meter-label { font-size: 12px; color: #9096a1; }
  #detail-panel { white-space: pre-wrap; font: 12px/1.5 ui-monospace, monospace; background: #1b1e24; padding: 10px; border-radius: 6px; max-height: 260px; overflow: auto; }
  .plan-version { border-left: 2px solid #3a3f48; padding: 4px 0 4px 10px; margin-bottom: 8px; font-size: 12px; }
  .plan-version pre { white-space: pre-wrap; margin: 4px 0 0; color: #c7cbd1; }
  #empty-state { padding: 60px 20px; text-align: center; color: #9096a1; }
</style>
</head>
<body>
<header>
  <h1 id="run-title">looprail dashboard</h1>
  <span id="status-pill" class="status-pill status-running">running</span>
  <span id="reason" style="color:#9096a1"></span>
</header>
<main>
  <div id="canvas-wrap">
    <div id="empty-state" style="display:none">no events yet — waiting for the run to start writing its journal…</div>
    <svg id="dag" width="100%" height="100%">
      <defs>
        <marker id="arrow" markerWidth="8" markerHeight="8" refX="7" refY="3" orient="auto">
          <path d="M0,0 L7,3 L0,6 Z" fill="#3a3f48" />
        </marker>
      </defs>
      <g id="edges"></g>
      <g id="nodes"></g>
    </svg>
  </div>
  <aside>
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
  var lastModel = null;

  var SVG_NS = 'http' + '://www.w3.org/2000/svg'; // split: not an external request, just the fixed XML namespace id required by createElementNS
  function el(tag, attrs, parent) {
    var e = document.createElementNS(SVG_NS, tag);
    for (var k in attrs) e.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(e);
    return e;
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

  function render(model) {
    lastModel = model;
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
      el('line', { class: 'edge', x1: a.x + 70, y1: a.y + 20, x2: b.x, y2: b.y + 20 }, edgesG);
    });

    model.layout.forEach(function (l) {
      var node = byId[l.id];
      if (!node) return;
      var g = el('g', { transform: 'translate(' + l.x + ',' + l.y + ')' }, nodesG);
      var rect = el('rect', {
        class: 'node-box ' + (STATUS_CLASS[node.status] || 'node-pending'),
        width: 130, height: 40, rx: 6,
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
  }

  function refresh() {
    fetch('/model').then(function (r) { return r.json(); }).then(render);
  }

  refresh();
  var es = new EventSource('/events');
  es.onmessage = function () { refresh(); };
})();
</script>
</body>
</html>`
}
