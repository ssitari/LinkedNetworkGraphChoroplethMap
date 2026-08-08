'use strict';

// ── Constants ────────────────────────────────────────────────────────────────
const MONTHS = ['All','January','February','March','April','May','June',
                'July','August','September','October','November','December'];
// DuckDB DAYOFWEEK: 0=Sunday … 6=Saturday
const DAYS = ['All','Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];

const BOROUGH_COLOR = {
  'Brooklyn':      '#e15759',
  'Manhattan':     '#4e79a7',
  'Queens':        '#f28e2b',
  'Bronx':         '#59a14f',
  'Staten Island': '#b07aa1',
};
const DEFAULT_COLOR = '#aaa';

// ── State ────────────────────────────────────────────────────────────────────
const state = {
  month:     null,   // null = all, 1-12 = specific month
  day:       null,   // null = all, 0-6 = day_of_week (Sun=0)
  mode:     'total', // 'total' | 'from' | 'to'
  threshold: 0,      // minimum edge weight to display
};

let selectedNode = null;

// ── SVG / layout setup ───────────────────────────────────────────────────────
const container   = document.getElementById('chart-container');
const svg         = d3.select('#chart');
const g           = svg.append('g');
const linkLayer   = g.append('g').attr('class', 'links');
const edgeLblLayer = g.append('g').attr('class', 'edge-labels');
const nodeLayer   = g.append('g').attr('class', 'nodes');

function dims() {
  const r = container.getBoundingClientRect();
  return { w: r.width, h: r.height };
}

// Zoom (namespace so we can also handle click separately)
svg.call(
  d3.zoom().scaleExtent([0.2, 10])
    .on('zoom', e => g.attr('transform', e.transform))
);

// Background click → deselect
svg.on('click.deselect', () => { clearHighlight(); selectedNode = null; });

// Tooltip
const tooltip = d3.select('#tooltip');

// ── Simulation (single persistent instance) ──────────────────────────────────
let simulation;
let simNodes    = [];
let rawWeighted = [];
let lastMetrics = null;

// ── Data ─────────────────────────────────────────────────────────────────────
let _data;

d3.json('network_data.json').then(data => {
  _data = data;
  document.getElementById('loading').style.display = 'none';

  data.nodes.forEach((n, i) => { n.index = i; });

  const { w, h } = dims();
  simNodes = data.nodes.map((n, i) => ({
    id: n.id, name: n.name, borough: n.borough, index: i,
    x: w / 2 + (Math.random() - 0.5) * 200,
    y: h / 2 + (Math.random() - 0.5) * 200,
  }));

  simulation = d3.forceSimulation(simNodes)
    .force('link',      d3.forceLink([]).id(d => d.index).distance(70))
    .force('charge',    d3.forceManyBody().strength(-130))
    .force('center',    d3.forceCenter(w / 2, h / 2))
    .force('collision', d3.forceCollide(6))
    .alphaDecay(0.025)
    .on('tick', ticked);

  buildLegend();
  initControls(data);
  render(data);
});

// ── Period helpers ───────────────────────────────────────────────────────────
function periodIndices(month, day) {
  const ms = month !== null ? [month]   : d3.range(1, 13);
  const ds = day   !== null ? [day]     : d3.range(0, 7);
  return ms.flatMap(m => ds.map(d => (m - 1) * 7 + d));
}

// ── Weight computation ───────────────────────────────────────────────────────
function computeWeights(data) {
  const periods = periodIndices(state.month, state.day);
  return data.links.map(l => {
    const ab = periods.reduce((s, k) => s + l.ab[k], 0);
    const ba = periods.reduce((s, k) => s + l.ba[k], 0);
    return { s: l.s, t: l.t, ab, ba, total: ab + ba };
  }).filter(l => l.total > 0);
}

function nodeMetrics(weightedLinks) {
  const m = new Float64Array(simNodes.length);
  for (const l of weightedLinks) {
    if (l.total < state.threshold) continue;
    if (state.mode === 'total') {
      m[l.s] += l.total; m[l.t] += l.total;
    } else if (state.mode === 'from') {
      m[l.s] += l.ab; m[l.t] += l.ba;
    } else {
      m[l.s] += l.ba; m[l.t] += l.ab;
    }
  }
  return m;
}

// ── Main render ──────────────────────────────────────────────────────────────
function render(data) {
  rawWeighted = computeWeights(data);
  initThresholdSlider(rawWeighted);
  applyThresholdAndDraw(data);
}

function applyThresholdAndDraw(data) {
  const activeLinks = rawWeighted.filter(l => l.total >= state.threshold);
  const metrics     = nodeMetrics(rawWeighted);
  lastMetrics = metrics;

  const maxMetric = d3.max(metrics) || 1;
  const maxWeight = d3.max(activeLinks, l => l.total) || 1;
  const rScale = d3.scaleSqrt().domain([0, maxMetric]).range([3, 24]);
  const wScale = d3.scalePow().exponent(0.4).domain([1, maxWeight]).range([0.3, 9]).clamp(true);

  // D3 forceLink requires source/target; mutates them in-place to node objects
  const simLinks = activeLinks.map(l => ({ ...l, source: l.s, target: l.t }));

  // ── Links ──
  const linkSel = linkLayer.selectAll('line')
    .data(simLinks, l => `${l.s}-${l.t}`);

  linkSel.enter().append('line')
    .attr('stroke', '#bbb')
    .attr('stroke-opacity', 0.5)
    .merge(linkSel)
    .attr('stroke-width', l => wScale(l.total));

  linkSel.exit().remove();

  // ── Nodes ──
  const nodeSel = nodeLayer.selectAll('circle')
    .data(simNodes, d => d.id);

  nodeSel.enter().append('circle')
    .attr('stroke', '#fff')
    .attr('stroke-width', 1.2)
    .attr('cursor', 'pointer')
    .call(drag())
    .on('mouseover', (event, d) => showTooltip(event, d, data))
    .on('mousemove', moveTooltip)
    .on('mouseout',  hideTooltip)
    .on('click', (event, d) => {
      event.stopPropagation();
      if (selectedNode && selectedNode.id === d.id) {
        clearHighlight();
        selectedNode = null;
      } else {
        selectedNode = d;
        highlight(d);
      }
    })
    .merge(nodeSel)
    .attr('r',       d => rScale(metrics[d.index]))
    .attr('fill',    d => BOROUGH_COLOR[d.borough] || DEFAULT_COLOR)
    .attr('opacity', d => metrics[d.index] > 0 ? 1 : 0.15);

  simulation.force('collision', d3.forceCollide().radius(d => rScale(metrics[d.index]) + 2));
  simulation.force('link').links(simLinks);
  simulation.alpha(0.6).restart();

  updateStats(activeLinks.length, Array.from(metrics).filter(v => v > 0).length);

  // Re-apply highlight if a node is selected (filter change may have updated weights)
  if (selectedNode) highlight(selectedNode);
}

// ── Highlight / clear ─────────────────────────────────────────────────────────
function highlight(node) {
  const currentLinks = linkLayer.selectAll('line').data();

  // Find links adjacent to selected node
  const adjLinks = currentLinks.filter(
    l => l.source.index === node.index || l.target.index === node.index
  );
  const neighborSet = new Set(adjLinks.flatMap(l => [l.source.index, l.target.index]));

  // Nodes: dim everything not in the neighborhood
  nodeLayer.selectAll('circle')
    .attr('opacity', d => neighborSet.has(d.index) ? 1 : 0.07)
    .attr('stroke',       d => d.index === node.index ? '#222' : '#fff')
    .attr('stroke-width', d => d.index === node.index ? 2.5   : 1.2);

  // Edges: dim non-adjacent, brighten adjacent
  linkLayer.selectAll('line')
    .attr('stroke-opacity', l =>
      (l.source.index === node.index || l.target.index === node.index) ? 0.85 : 0.04
    );

  // Edge labels showing trip count for each adjacent edge
  const modeLabel = { total: 'total', from: 'departures', to: 'arrivals' }[state.mode];

  edgeLblLayer.selectAll('text').remove();

  edgeLblLayer.selectAll('text')
    .data(adjLinks)
    .enter().append('text')
    .attr('text-anchor', 'middle')
    .attr('dominant-baseline', 'central')
    .attr('font-size', '10px')
    .attr('font-weight', '700')
    .attr('fill', '#222')
    .attr('paint-order', 'stroke')
    .attr('stroke', 'white')
    .attr('stroke-width', '3px')
    .attr('stroke-linejoin', 'round')
    .attr('pointer-events', 'none')
    .text(l => {
      // For From/To modes, show the directional metric relative to selected node
      if (state.mode === 'total') return l.total.toLocaleString();
      const nodeIsS = l.s === node.index;
      const val = state.mode === 'from'
        ? (nodeIsS ? l.ab : l.ba)   // departures from selected node
        : (nodeIsS ? l.ba : l.ab);  // arrivals to selected node
      return val.toLocaleString();
    });
}

function clearHighlight() {
  nodeLayer.selectAll('circle')
    .attr('opacity',      d => (lastMetrics && lastMetrics[d.index] > 0) ? 1 : 0.15)
    .attr('stroke',       '#fff')
    .attr('stroke-width', 1.2);

  linkLayer.selectAll('line')
    .attr('stroke-opacity', 0.5);

  edgeLblLayer.selectAll('text').remove();
}

// ── Tick ─────────────────────────────────────────────────────────────────────
function ticked() {
  linkLayer.selectAll('line')
    .attr('x1', d => d.source.x)
    .attr('y1', d => d.source.y)
    .attr('x2', d => d.target.x)
    .attr('y2', d => d.target.y);

  nodeLayer.selectAll('circle')
    .attr('cx', d => d.x)
    .attr('cy', d => d.y);

  // Keep edge labels at edge midpoints as sim runs
  edgeLblLayer.selectAll('text')
    .attr('x', d => (d.source.x + d.target.x) / 2)
    .attr('y', d => (d.source.y + d.target.y) / 2);
}

// ── Drag ─────────────────────────────────────────────────────────────────────
function drag() {
  return d3.drag()
    .on('start', (event, d) => {
      if (!event.active) simulation.alphaTarget(0.3).restart();
      d.fx = d.x; d.fy = d.y;
    })
    .on('drag',  (event, d) => { d.fx = event.x; d.fy = event.y; })
    .on('end',   (event, d) => {
      if (!event.active) simulation.alphaTarget(0);
      d.fx = null; d.fy = null;
    });
}

// ── Tooltip ───────────────────────────────────────────────────────────────────
function showTooltip(event, d, data) {
  const periods = periodIndices(state.month, state.day);
  let out = 0, inn = 0;
  for (const l of data.links) {
    if (l.s === d.index || l.t === d.index) {
      const ab = periods.reduce((s, k) => s + l.ab[k], 0);
      const ba = periods.reduce((s, k) => s + l.ba[k], 0);
      if (l.s === d.index) { out += ab; inn += ba; }
      else                  { out += ba; inn += ab; }
    }
  }
  tooltip.style('display', 'block').html(
    `<strong>${d.name}</strong><br>${d.borough}<br>` +
    `Departures: ${out.toLocaleString()}<br>` +
    `Arrivals: &nbsp;${inn.toLocaleString()}<br>` +
    `Total: &nbsp;&nbsp;&nbsp;&nbsp;${(out + inn).toLocaleString()}`
  );
  moveTooltip(event);
}
function moveTooltip(event) {
  tooltip.style('left', (event.pageX + 14) + 'px').style('top', (event.pageY - 32) + 'px');
}
function hideTooltip() { tooltip.style('display', 'none'); }

// ── Stats ─────────────────────────────────────────────────────────────────────
function updateStats(edges, nodes) {
  document.getElementById('stat-edges').textContent = edges.toLocaleString();
  document.getElementById('stat-nodes').textContent = nodes;
}

// ── Controls ─────────────────────────────────────────────────────────────────
function initControls(data) {
  const monthSel = d3.select('#month-sel');
  MONTHS.forEach((m, i) =>
    monthSel.append('option').attr('value', i === 0 ? '' : i).text(m));
  monthSel.on('change', function () {
    state.month = this.value ? +this.value : null;
    rawWeighted = computeWeights(data);
    initThresholdSlider(rawWeighted);
    applyThresholdAndDraw(data);
  });

  const daySel = d3.select('#day-sel');
  DAYS.forEach((d, i) =>
    daySel.append('option').attr('value', i === 0 ? '' : i - 1).text(d));
  daySel.on('change', function () {
    state.day = this.value !== '' ? +this.value : null;
    rawWeighted = computeWeights(data);
    initThresholdSlider(rawWeighted);
    applyThresholdAndDraw(data);
  });

  d3.selectAll('input[name="mode"]').on('change', function () {
    state.mode = this.value;
    applyThresholdAndDraw(data);
  });

  document.getElementById('threshold-slider').addEventListener('input', function () {
    state.threshold = +this.value;
    document.getElementById('threshold-val').textContent = (+this.value).toLocaleString();
    applyThresholdAndDraw(data);
  });
}

let sliderInitialized = false;
function initThresholdSlider(weightedLinks) {
  const weights = weightedLinks.map(l => l.total).sort(d3.ascending);
  const q75 = Math.round(d3.quantile(weights, 0.75));
  const q99 = Math.round(d3.quantile(weights, 0.99));
  const slider = document.getElementById('threshold-slider');
  slider.max = q99;
  if (!sliderInitialized) {
    slider.value = q75;
    state.threshold = q75;
    document.getElementById('threshold-val').textContent = q75.toLocaleString();
    sliderInitialized = true;
  }
}

// ── Legend ────────────────────────────────────────────────────────────────────
function buildLegend() {
  const cont = d3.select('#legend')
    .style('display', 'flex').style('flex-direction', 'column').style('gap', '5px');
  Object.entries(BOROUGH_COLOR).forEach(([name, color]) => {
    const row = cont.append('div').attr('class', 'legend-item');
    row.append('div').attr('class', 'swatch').style('background', color);
    row.append('span').text(name);
  });
}
