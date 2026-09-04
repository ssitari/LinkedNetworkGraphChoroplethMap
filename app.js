'use strict';

// ── Constants ────────────────────────────────────────────────────────────────
const MONTHS = [
  'All months',
  'January','February','March','April','May','June',
  'July','August','September','October','November','December',
];

const BOROUGH_COLOR = {
  'Brooklyn':      '#e15759',
  'Manhattan':     '#4e79a7',
  'Queens':        '#f28e2b',
  'Bronx':         '#59a14f',
  'Staten Island': '#b07aa1',
};
const DEFAULT_COLOR = '#aaa';

// Node opacity. Applied on the g.node group only -- never also on its children,
// or the two multiply and inactive nodes all but vanish.
const INACTIVE_OPACITY = 0.15;  // node carries no trips at the current threshold
const FADED_OPACITY    = 0.07;  // node is not adjacent to the selection

// ── State ────────────────────────────────────────────────────────────────────
const state = {
  month:        null,    // null = all months, 1-12 = specific month
  mode:        'total',  // 'total' | 'from' | 'to'
  thresholdPct: 50,      // share of edges hidden -- what the slider sets
  threshold:    0,       // trip cutoff that percentile resolves to, this period
};

let selectedNode  = null;
let lastMetrics   = null;
let geoIdToIndex  = {};
let sortedWeights = [];

// ── SVG / layout ─────────────────────────────────────────────────────────────
const container    = document.getElementById('chart-container');
const svg          = d3.select('#chart');
const g            = svg.append('g');
const linkLayer = g.append('g').attr('class', 'links');
const nodeLayer = g.append('g').attr('class', 'nodes');

// ── Map SVG ───────────────────────────────────────────────────────────────────
const mapContainer = document.getElementById('map-container');
const mapSvg       = d3.select('#map');
const mapG         = mapSvg.append('g');
const choroplethScale = d3.scaleSequential(d3.interpolateYlGnBu);

function dims() {
  const r = container.getBoundingClientRect();
  return { w: r.width, h: r.height };
}

svg.call(
  d3.zoom().scaleExtent([0.2, 10])
    .on('zoom', e => g.attr('transform', e.transform))
);

svg.on('click.deselect', () => { clearHighlight(); selectedNode = null; updateChoropleth(null); });

const tooltip = d3.select('#tooltip');

// ── Simulation ───────────────────────────────────────────────────────────────
let simulation;
let simNodes    = [];
let rawWeighted = [];

// ── Data load ─────────────────────────────────────────────────────────────────
Promise.all([
  d3.json('cdta_network_data.json'),
  d3.json('CDTAs.geojson'),
]).then(([data, geo]) => {
  document.getElementById('loading').style.display = 'none';

  const { w, h } = dims();
  simNodes = data.nodes.map((n, i) => ({
    id: n.id, name: n.name, short_name: n.short_name, borough: n.borough, index: i,
    x: w / 2 + (Math.random() - 0.5) * 300,
    y: h / 2 + (Math.random() - 0.5) * 300,
  }));

  simulation = d3.forceSimulation(simNodes)
    .force('link',      d3.forceLink([]).id(d => d.index).distance(80))
    .force('charge',    d3.forceManyBody().strength(-200))
    .force('center',    d3.forceCenter(w / 2, h / 2))
    .force('collision', d3.forceCollide(10))
    .alphaDecay(0.02)
    .on('tick', ticked);

  buildLegend();
  initControls(data);
  initMap(geo, data);
  render(data);
}).catch(err => {
  console.error(err);
  const el = document.getElementById('loading');
  el.textContent = 'Could not load the network data. Try reloading the page.';
  el.style.display = 'flex';
});

// ── Period helpers ────────────────────────────────────────────────────────────
function periodIndices(month) {
  return month !== null ? [month - 1] : d3.range(0, 12);
}

// ── Weight computation ────────────────────────────────────────────────────────
function computeWeights(data) {
  const periods = periodIndices(state.month);
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

// ── Main render ───────────────────────────────────────────────────────────────
function render(data) {
  rawWeighted = computeWeights(data);
  recomputeThresholdScale(rawWeighted);
  applyThresholdAndDraw(data);
}

function applyThresholdAndDraw(data) {
  const activeLinks = rawWeighted.filter(l => l.total >= state.threshold);
  const metrics     = nodeMetrics(rawWeighted);
  lastMetrics = metrics;

  const maxMetric = d3.max(metrics) || 1;
  const maxWeight = d3.max(activeLinks, l => l.total) || 1;
  const rScale = d3.scaleSqrt().domain([0, maxMetric]).range([4, 28]);
  const wScale = d3.scalePow().exponent(0.4).domain([1, maxWeight]).range([0.5, 10]).clamp(true);

  const simLinks = activeLinks.map(l => ({ ...l, source: l.s, target: l.t }));

  // ── Links ──
  const linkSel = linkLayer.selectAll('line')
    .data(simLinks, l => `${l.s}-${l.t}`);

  linkSel.enter().append('line')
    .attr('stroke', '#888')
    .attr('stroke-opacity', 0.35)
    .merge(linkSel)
    .attr('stroke-width', l => wScale(l.total));

  linkSel.exit().remove();

  // ── Nodes ──
  const nodeSel = nodeLayer.selectAll('g.node')
    .data(simNodes, d => d.id);

  const nodeEnter = nodeSel.enter().append('g')
    .attr('class', 'node')
    .attr('cursor', 'pointer')
    .call(drag())
    .on('mouseover', (event, d) => showTooltip(event, d))
    .on('mousemove', moveTooltip)
    .on('mouseout',  hideTooltip)
    .on('click', (event, d) => {
      event.stopPropagation();
      if (selectedNode && selectedNode.id === d.id) {
        clearHighlight();
        selectedNode = null;
        updateChoropleth(null);
      } else {
        selectedNode = d;
        updateChoropleth(d.index);
        highlight(d);
      }
    });

  nodeEnter.append('circle')
    .attr('stroke', '#fff')
    .attr('stroke-width', 1.2);

  nodeEnter.append('text')
    .attr('text-anchor', 'middle')
    .attr('dominant-baseline', 'hanging')
    .attr('pointer-events', 'none')
    .attr('fill', '#ddd')
    .attr('font-weight', '600')
    .attr('paint-order', 'stroke')
    .attr('stroke', '#141414')
    .attr('stroke-width', '3px')
    .attr('stroke-linejoin', 'round')
    .style('font-family', 'system-ui, sans-serif');

  const nodeAll = nodeEnter.merge(nodeSel);

  nodeAll.attr('opacity', d => metrics[d.index] > 0 ? 1 : INACTIVE_OPACITY);

  nodeAll.select('circle')
    .attr('r',    d => rScale(metrics[d.index]))
    .attr('fill', d => BOROUGH_COLOR[d.borough] || DEFAULT_COLOR);

  nodeAll.select('text')
    .attr('font-size', '9px')
    .attr('dy', d => rScale(metrics[d.index]) + 3)
    .text(d => d.short_name);

  simulation.force('collision', d3.forceCollide().radius(d => rScale(metrics[d.index]) + 3));
  simulation.force('link').links(simLinks);
  simulation.alpha(0.6).restart();

  updateStats(activeLinks.length, Array.from(metrics).filter(v => v > 0).length);

  updateChoropleth(selectedNode ? selectedNode.index : null);
  if (selectedNode) highlight(selectedNode);
}

// ── Highlight / clear ─────────────────────────────────────────────────────────
function highlight(node) {
  const currentLinks = linkLayer.selectAll('line').data();

  const adjLinks = currentLinks.filter(
    l => l.source.index === node.index || l.target.index === node.index
  );
  const neighborSet = new Set(adjLinks.flatMap(l => [l.source.index, l.target.index]));

  const weightMap = {};
  for (const l of adjLinks) {
    const isSource = l.source.index === node.index;
    const otherIdx = isSource ? l.target.index : l.source.index;
    const val = state.mode === 'total' ? l.total
      : state.mode === 'from' ? (isSource ? l.ab : l.ba)
      : (isSource ? l.ba : l.ab);
    weightMap[otherIdx] = val;
  }

  nodeLayer.selectAll('g.node')
    .attr('opacity', d => neighborSet.has(d.index) ? 1 : FADED_OPACITY);

  nodeLayer.selectAll('g.node circle')
    .attr('fill', d => {
      if (d.index === node.index) return BOROUGH_COLOR[d.borough] || DEFAULT_COLOR;
      const w = weightMap[d.index];
      return w ? choroplethScale(w) : (BOROUGH_COLOR[d.borough] || DEFAULT_COLOR);
    })
    .attr('stroke',       d => d.index === node.index ? '#fff' : 'rgba(0,0,0,0.4)')
    .attr('stroke-width', d => d.index === node.index ? 3 : 0.8);

  linkLayer.selectAll('line')
    .attr('stroke-opacity', l =>
      (l.source.index === node.index || l.target.index === node.index) ? 0.85 : 0.04
    );
}

function clearHighlight() {
  nodeLayer.selectAll('g.node')
    .attr('opacity', d => (lastMetrics && lastMetrics[d.index] > 0) ? 1 : INACTIVE_OPACITY);

  nodeLayer.selectAll('g.node circle')
    .attr('fill', d => BOROUGH_COLOR[d.borough] || DEFAULT_COLOR)
    .attr('stroke', '#fff')
    .attr('stroke-width', 1.2);

  linkLayer.selectAll('line')
    .attr('stroke-opacity', 0.35);
}

// ── Tick ──────────────────────────────────────────────────────────────────────
function ticked() {
  linkLayer.selectAll('line')
    .attr('x1', d => d.source.x).attr('y1', d => d.source.y)
    .attr('x2', d => d.target.x).attr('y2', d => d.target.y);

  nodeLayer.selectAll('g.node')
    .attr('transform', d => `translate(${d.x},${d.y})`);
}

// ── Drag ──────────────────────────────────────────────────────────────────────
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
function showTooltip(event, d) {
  // Reads rawWeighted, already reduced to the selected period, and applies the
  // same threshold as the draw -- so these totals match what is on screen.
  let out = 0, inn = 0;
  for (const l of rawWeighted) {
    if (l.total < state.threshold) continue;
    if      (l.s === d.index) { out += l.ab; inn += l.ba; }
    else if (l.t === d.index) { out += l.ba; inn += l.ab; }
  }
  tooltip.style('display', 'block').html(
    `<strong>${d.id}</strong><br>${d.short_name}<br>${d.borough}<br>` +
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

// ── Stats ──────────────────────────────────────────────────────────────────────
function updateStats(edges, nodes) {
  document.getElementById('stat-edges').textContent = edges.toLocaleString();
  document.getElementById('stat-nodes').textContent = nodes;
}

// ── Controls ──────────────────────────────────────────────────────────────────
function initControls(data) {
  const monthSel = d3.select('#month-sel');
  MONTHS.forEach((m, i) =>
    monthSel.append('option').attr('value', i === 0 ? '' : i).text(m)
  );
  monthSel.on('change', function () {
    state.month = this.value ? +this.value : null;
    rawWeighted = computeWeights(data);
    recomputeThresholdScale(rawWeighted);
    applyThresholdAndDraw(data);
  });

  d3.selectAll('input[name="mode"]').on('change', function () {
    state.mode = this.value;
    applyThresholdAndDraw(data);
  });

  document.getElementById('threshold-slider').addEventListener('input', function () {
    state.thresholdPct = +this.value;
    state.threshold    = resolveThreshold();
    syncThresholdLabel();
    applyThresholdAndDraw(data);
  });
}

// The slider is percentile-spaced. Edge weights span four orders of magnitude
// (q50 ~674, max ~1.5M over the full year), so a linear track buries every
// useful cutoff in its leftmost 1%. Holding a percentile also keeps the filter
// meaningful across periods -- an absolute cutoff tuned on twelve months of
// trips empties out a single month.
function resolveThreshold() {
  if (!sortedWeights.length || state.thresholdPct <= 0) return 0;
  return Math.round(d3.quantile(sortedWeights, state.thresholdPct / 100));
}

function syncThresholdLabel() {
  document.getElementById('threshold-val').textContent =
    state.threshold ? '\u2265' + state.threshold.toLocaleString() : 'all';
}

function recomputeThresholdScale(weightedLinks) {
  sortedWeights = weightedLinks.map(l => l.total).sort(d3.ascending);
  state.threshold = resolveThreshold();
  syncThresholdLabel();
}

// ── Map ───────────────────────────────────────────────────────────────────────
function initMap(geo, data) {
  data.nodes.forEach((n, i) => { geoIdToIndex[n.id] = i; });

  const r = mapContainer.getBoundingClientRect();
  const projection = d3.geoMercator().fitSize([r.width, r.height], geo);
  const path = d3.geoPath(projection);

  mapG.selectAll('path')
    .data(geo.features, f => f.properties.CDTA2020)
    .enter().append('path')
    .attr('d', path)
    .attr('fill', '#2a2a2a')
    .attr('stroke', '#444')
    .attr('stroke-width', 0.5)
    .attr('cursor', 'pointer')
    .on('mouseover', (event, f) => showMapTooltip(event, f))
    .on('mousemove', moveTooltip)
    .on('mouseout', hideTooltip)
    .on('click', (event, f) => {
      event.stopPropagation();
      const nodeIdx = geoIdToIndex[f.properties.CDTA2020];
      if (nodeIdx === undefined) return;
      const node = simNodes[nodeIdx];
      if (selectedNode && selectedNode.id === node.id) {
        clearHighlight();
        selectedNode = null;
        updateChoropleth(null);
      } else {
        selectedNode = node;
        updateChoropleth(nodeIdx);
        highlight(node);
      }
    });

  buildMapLegend();

  window.addEventListener('resize', () => {
    const nr = mapContainer.getBoundingClientRect();
    projection.fitSize([nr.width, nr.height], geo);
    mapG.selectAll('path').attr('d', path);
    positionLegend();
  });
}

function buildMapLegend() {
  const defs = mapSvg.append('defs');
  const grad = defs.append('linearGradient').attr('id', 'clegend-grad');
  d3.range(0, 1.01, 0.05).forEach(t => {
    grad.append('stop')
      .attr('offset', `${(t * 100).toFixed(0)}%`)
      .attr('stop-color', d3.interpolateYlGnBu(t));
  });

  const lg = mapSvg.append('g').attr('class', 'map-legend').attr('pointer-events', 'none');

  lg.append('text').attr('class', 'legend-title')
    .attr('y', -5).attr('fill', '#bbb').attr('font-size', '10px')
    .attr('font-weight', '600').attr('font-family', 'system-ui, sans-serif');

  lg.append('rect').attr('class', 'legend-bar')
    .attr('y', 0).attr('height', 8).attr('fill', 'url(#clegend-grad)');

  lg.append('text').attr('class', 'legend-min')
    .attr('y', 18).attr('fill', '#888').attr('font-size', '9px')
    .attr('font-family', 'system-ui, sans-serif').text('0');

  lg.append('text').attr('class', 'legend-max')
    .attr('y', 18).attr('text-anchor', 'end')
    .attr('fill', '#888').attr('font-size', '9px')
    .attr('font-family', 'system-ui, sans-serif');

  positionLegend();
}

function positionLegend() {
  const r = mapContainer.getBoundingClientRect();
  const LW = Math.min(180, r.width - 24);
  mapSvg.select('.map-legend').attr('transform', `translate(12, ${r.height - 28})`);
  mapSvg.select('.legend-bar').attr('width', LW);
  mapSvg.select('.legend-max').attr('x', LW);
}

function updateLegend(maxVal, selectedIndex) {
  const metric = state.mode === 'from' ? 'Departures'
    : state.mode === 'to' ? 'Arrivals'
    :                       'Total trips';
  const title = selectedIndex === null
    ? metric
    : `${state.mode === 'total' ? 'Trips' : metric} — ${simNodes[selectedIndex].id}`;
  mapSvg.select('.legend-title').text(title);
  mapSvg.select('.legend-max').text(maxVal.toLocaleString());
}

function updateChoropleth(selectedIndex) {
  if (!mapG.selectAll('path').size()) return;

  const valueMap = {};
  if (selectedIndex === null) {
    simNodes.forEach(n => { valueMap[n.id] = lastMetrics ? lastMetrics[n.index] : 0; });
  } else {
    for (const l of rawWeighted) {
      if (l.total < state.threshold) continue;
      if (l.s === selectedIndex) {
        const val = state.mode === 'from' ? l.ab : state.mode === 'to' ? l.ba : l.total;
        valueMap[simNodes[l.t].id] = val;
      } else if (l.t === selectedIndex) {
        const val = state.mode === 'from' ? l.ba : state.mode === 'to' ? l.ab : l.total;
        valueMap[simNodes[l.s].id] = val;
      }
    }
  }

  const maxVal = d3.max(Object.values(valueMap)) || 1;
  choroplethScale.domain([0, maxVal]);
  updateLegend(maxVal, selectedIndex);

  mapG.selectAll('path')
    .attr('fill', f => {
      const id = f.properties.CDTA2020;
      if (selectedIndex !== null && simNodes[selectedIndex].id === id) {
        return BOROUGH_COLOR[f.properties.BoroName] || DEFAULT_COLOR;
      }
      const val = valueMap[id];
      return val ? choroplethScale(val) : '#2a2a2a';
    })
    .attr('stroke', f =>
      selectedIndex !== null && simNodes[selectedIndex].id === f.properties.CDTA2020
        ? '#fff' : '#444'
    )
    .attr('stroke-width', f =>
      selectedIndex !== null && simNodes[selectedIndex].id === f.properties.CDTA2020
        ? 2 : 0.5
    );
}

function showMapTooltip(event, f) {
  const nodeIdx = geoIdToIndex[f.properties.CDTA2020];
  if (nodeIdx !== undefined) {
    showTooltip(event, simNodes[nodeIdx]);
  } else {
    tooltip.style('display', 'block').html(
      `<strong>${f.properties.CDTA2020}</strong><br>` +
      `${f.properties.CDTAName.trim()}<br>${f.properties.BoroName}`
    );
    moveTooltip(event);
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
