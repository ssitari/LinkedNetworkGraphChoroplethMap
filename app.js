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

// Map fills for districts the choropleth cannot colour. 28 of the 71 CDTAs have
// no Citi Bike stations at all and never will; a served district can also fall
// empty at a high filter. Those are different facts, so they get different greys.
const NO_STATIONS_COLOR = '#1e1e1e';
const NO_TRIPS_COLOR    = '#333333';

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
// Appended last, so every label paints over every circle. While the labels
// lived inside their own g.node, a node drawn later covered the text of one
// drawn earlier, which is half of why the dense middle was unreadable.
const labelLayer = g.append('g').attr('class', 'labels').attr('pointer-events', 'none');

// ── Map SVG ───────────────────────────────────────────────────────────────────
const mapContainer = document.getElementById('map-container');
const mapSvg       = d3.select('#map');
const mapG         = mapSvg.append('g');
const choroplethScale = d3.scaleSequential(d3.interpolateYlGnBu);

// Falls back to nominal dimensions: below the 760px breakpoint the panels are
// display:none and measure 0, which would centre the simulation on the origin.
function dims() {
  const r = container.getBoundingClientRect();
  return { w: r.width || 900, h: r.height || 700 };
}

svg.call(
  d3.zoom().scaleExtent([0.2, 10])
    .on('zoom', e => g.attr('transform', e.transform))
);

svg.on('click.deselect', () => { clearHighlight(); selectedNode = null; updateChoropleth(null); });

// ── Map zoom / deselect ───────────────────────────────────────────────────────
let mapK       = 1;     // live map zoom scale, so borders stay hairline
let selectedId = null;  // CDTA2020 code of the selected district, or null

function pathStrokeWidth(f) {
  return (f.properties.CDTA2020 === selectedId ? 2 : 0.5) / mapK;
}

mapSvg.call(
  d3.zoom().scaleExtent([1, 12])
    .on('zoom', e => {
      mapK = e.transform.k;
      mapG.attr('transform', e.transform);
      mapG.selectAll('path').attr('stroke-width', pathStrokeWidth);
    })
);

mapSvg.on('click.deselect', () => { clearHighlight(); selectedNode = null; updateChoropleth(null); });

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

  buildLegend(data);
  initControls(data);
  initMap(geo, data);
  render(data);
}).catch(err => {
  console.error(err);
  const el = document.getElementById('loading');
  el.textContent = 'Could not load the network data. Try reloading the page.';
  el.style.display = 'flex';
});

// ── Resize ────────────────────────────────────────────────────────────────────
// Both panels reproject. The network previously kept its load-time forceCenter,
// so the graph drifted off-centre as the window changed.
let onMapResize = null;
let resizeTimer = null;

window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (simulation) {
      const { w, h } = dims();
      simulation.force('center', d3.forceCenter(w / 2, h / 2));
      simulation.alpha(0.3).restart();
    }
    if (onMapResize) onMapResize();
  }, 150);
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

  const nodeAll = nodeEnter.merge(nodeSel);

  // Radius onto the datum: label placement needs it outside this function.
  simNodes.forEach(d => { d.r = rScale(metrics[d.index]); });

  nodeAll.attr('opacity', d => metrics[d.index] > 0 ? 1 : INACTIVE_OPACITY);

  nodeAll.select('circle')
    .attr('r',    d => d.r)
    .attr('fill', d => BOROUGH_COLOR[d.borough] || DEFAULT_COLOR);

  // ── Labels ──
  // simNodes never changes, so this enters once: the text is set and measured a
  // single time and the width cached on the datum for the placement pass.
  labelLayer.selectAll('text.label')
    .data(simNodes, d => d.id)
    .enter().append('text')
    .attr('class', 'label')
    .attr('text-anchor', 'middle')
    .attr('dominant-baseline', 'hanging')
    .attr('fill', '#ddd')
    .attr('font-size', '9px')
    .attr('font-weight', '600')
    .attr('paint-order', 'stroke')
    .attr('stroke', '#141414')
    .attr('stroke-width', '3px')
    .attr('stroke-linejoin', 'round')
    .style('font-family', 'system-ui, sans-serif')
    .text(d => d.short_name);

  simulation.force('collision', d3.forceCollide().radius(d => d.r + 3));
  simulation.force('link').links(simLinks);
  simulation.alpha(0.6).restart();

  updateStats(activeLinks.length, Array.from(metrics).filter(v => v > 0).length);

  updateChoropleth(selectedNode ? selectedNode.index : null);
  if (selectedNode) highlight(selectedNode);
  refreshLabels();
}

// ── Label placement ───────────────────────────────────────────────────────────
// Greedy, largest node first: each label takes the first of four slots -- below,
// above, right, left -- that clears both the labels already placed and every
// circle currently drawn. A node with no free slot goes unlabelled; its name is
// still one hover away in the tooltip, so nothing is lost but the clutter.
//
// Only the slot *choice* is throttled. Coordinates are recomputed from the live
// node position on every tick, so labels track their node smoothly instead of
// lagging behind it between reassignments.
const LABEL_H       = 11;  // line box of the 9px face
const LABEL_GAP     = 3;
const SLOTS         = [0, 1, 2, 3];
const REPLACE_EVERY = 1;   // ticks between slot reassignments

const LABEL_CHAR_W  = 5;   // ~9px semibold system-ui, used only as a fallback

let labelNeighbors = null;  // while a node is selected, the set that keeps labels
let tickCount      = 0;

// getComputedTextLength() reports 0 until the text has been laid out, and the
// first draw happens before that -- measuring in the enter selection silently
// produced 43 zero-width boxes and hid every label. So measure lazily, keep
// retrying until a real number arrives, and fall back to a character-count
// estimate meanwhile: approximate boxes degrade far better than no labels.
function measureLabels() {
  labelLayer.selectAll('text.label').each(function (d) {
    if (d.labelMeasured) return;
    const w = this.getComputedTextLength() ||
              (this.getBBox ? this.getBBox().width : 0);
    if (w > 0) { d.labelW = w; d.labelMeasured = true; }
    else if (!d.labelW) { d.labelW = d.short_name.length * LABEL_CHAR_W; }
  });
}

function labelAnchor(d, slot) {
  const r = d.r || 4, hw = (d.labelW || 0) / 2;
  if (slot === 0) return { cx: d.x, top: d.y + r + LABEL_GAP };
  if (slot === 1) return { cx: d.x, top: d.y - r - LABEL_GAP - LABEL_H };
  if (slot === 2) return { cx: d.x + r + LABEL_GAP + hw, top: d.y - LABEL_H / 2 };
  return { cx: d.x - r - LABEL_GAP - hw, top: d.y - LABEL_H / 2 };
}

function labelRect(d, slot) {
  const a = labelAnchor(d, slot), hw = (d.labelW || 0) / 2;
  return { x0: a.cx - hw, y0: a.top, x1: a.cx + hw, y1: a.top + LABEL_H };
}

function rectsOverlap(a, b) {
  return a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
}

function rectHitsCircle(r, cx, cy, rad) {
  const nx = Math.max(r.x0, Math.min(cx, r.x1));
  const ny = Math.max(r.y0, Math.min(cy, r.y1));
  const dx = cx - nx, dy = cy - ny;
  return dx * dx + dy * dy < rad * rad;
}

// Labelled only if the node is actually carrying trips, and -- when something
// is selected -- only if it is adjacent to the selection. The rest are faded
// to near-invisible, so labelling them would just be clutter over nothing.
function labelEligible(d) {
  return !!lastMetrics && lastMetrics[d.index] > 0 &&
         (!labelNeighbors || labelNeighbors.has(d.index));
}

function assignLabelSlots() {
  if (!lastMetrics) return;
  measureLabels();
  const drawn  = simNodes.filter(labelEligible);
  const placed = [];

  // Selection first when there is one, then biggest to smallest, so the labels
  // that survive a crowded patch are the ones worth reading.
  const priority = d =>
    (labelNeighbors && selectedNode && d.index === selectedNode.index)
      ? Infinity : lastMetrics[d.index];

  simNodes.forEach(d => { d.showLabel = false; });

  for (const d of drawn.slice().sort((a, b) => priority(b) - priority(a))) {
    if (!d.labelW) continue;
    const hit = pickSlot(d, drawn, placed);
    if (!hit) continue;
    d.showLabel = true;
    d.slot = hit.slot;
    placed.push(hit.rect);
  }
}

// Two passes. The first also refuses to sit on another node's circle, which is
// what you want wherever there is room. This graph rarely has room -- forceCollide
// packs the nodes nearly touching, and demanding a circle-free slot hid all 43
// labels -- so the second pass drops that and asks only that labels not cover each
// other. Text over a circle still reads: the labels carry a dark halo and now sit
// above every node.
function pickSlot(d, drawn, placed) {
  const order = d.slot === undefined
    ? SLOTS : [d.slot, ...SLOTS.filter(s => s !== d.slot)];
  for (const avoidCircles of [true, false]) {
    for (const slot of order) {
      const r = labelRect(d, slot);
      if (placed.some(p => rectsOverlap(r, p))) continue;
      if (avoidCircles &&
          drawn.some(o => o !== d && rectHitsCircle(r, o.x, o.y, o.r || 4))) continue;
      return { slot, rect: r };
    }
  }
  return null;
}

function positionLabels() {
  labelLayer.selectAll('text.label').each(function (d) {
    if (!d.showLabel) { this.setAttribute('opacity', 0); return; }
    const a = labelAnchor(d, d.slot);
    this.setAttribute('opacity', 1);
    this.setAttribute('x', a.cx);
    this.setAttribute('y', a.top);
  });
}

// Selection does not restart the simulation, so ticked() may never fire after a
// click -- highlight and clearHighlight have to refresh the labels themselves.
function refreshLabels() {
  assignLabelSlots();
  positionLabels();
}

// ── Highlight / clear ─────────────────────────────────────────────────────────
function highlight(node) {
  const currentLinks = linkLayer.selectAll('line').data();

  const adjLinks = currentLinks.filter(
    l => l.source.index === node.index || l.target.index === node.index
  );
  const neighborSet = new Set(adjLinks.flatMap(l => [l.source.index, l.target.index]));
  neighborSet.add(node.index);  // keep the selection lit even with every edge filtered out
  labelNeighbors = neighborSet;

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

  refreshLabels();
}

function clearHighlight() {
  labelNeighbors = null;

  nodeLayer.selectAll('g.node')
    .attr('opacity', d => (lastMetrics && lastMetrics[d.index] > 0) ? 1 : INACTIVE_OPACITY);

  nodeLayer.selectAll('g.node circle')
    .attr('fill', d => BOROUGH_COLOR[d.borough] || DEFAULT_COLOR)
    .attr('stroke', '#fff')
    .attr('stroke-width', 1.2);

  linkLayer.selectAll('line')
    .attr('stroke-opacity', 0.35);

  refreshLabels();
}

// ── Tick ──────────────────────────────────────────────────────────────────────
function ticked() {
  linkLayer.selectAll('line')
    .attr('x1', d => d.source.x).attr('y1', d => d.source.y)
    .attr('x2', d => d.target.x).attr('y2', d => d.target.y);

  nodeLayer.selectAll('g.node')
    .attr('transform', d => `translate(${d.x},${d.y})`);

  if (++tickCount % REPLACE_EVERY === 0) assignLabelSlots();
  positionLabels();
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
  const projection = d3.geoMercator()
    .fitSize([r.width || 900, r.height || 700], geo);
  const path = d3.geoPath(projection);

  mapG.selectAll('path')
    .data(geo.features, f => f.properties.CDTA2020)
    .enter().append('path')
    .attr('d', path)
    .attr('fill', f => geoIdToIndex[f.properties.CDTA2020] === undefined
      ? NO_STATIONS_COLOR : NO_TRIPS_COLOR)
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

  onMapResize = () => {
    const nr = mapContainer.getBoundingClientRect();
    if (!nr.width || !nr.height) return;
    projection.fitSize([nr.width, nr.height], geo);
    mapG.selectAll('path').attr('d', path);
    positionLegend();
  };
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

  selectedId = selectedIndex === null ? null : simNodes[selectedIndex].id;

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
      if (id === selectedId) return BOROUGH_COLOR[f.properties.BoroName] || DEFAULT_COLOR;
      const val = valueMap[id];
      if (val) return choroplethScale(val);
      return geoIdToIndex[id] === undefined ? NO_STATIONS_COLOR : NO_TRIPS_COLOR;
    })
    .attr('stroke', f => f.properties.CDTA2020 === selectedId ? '#fff' : '#444')
    .attr('stroke-width', pathStrokeWidth);
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
function swatchRow(cont, color, label, isArea) {
  const row = cont.append('div').attr('class', 'legend-item');
  const sw = row.append('div')
    .attr('class', isArea ? 'swatch area' : 'swatch')
    .style('background', color);
  if (isArea) sw.style('border', '1px solid #555');
  row.append('span').text(label);
}

function buildLegend(data) {
  // Driven by the data, not by BOROUGH_COLOR: Citi Bike does not serve Staten
  // Island, so a hard-coded list advertises a swatch that never appears.
  const present = new Set(data.nodes.map(n => n.borough));
  const col = sel => d3.select(sel)
    .style('display', 'flex').style('flex-direction', 'column').style('gap', '5px');

  const nodeKey = col('#legend');
  Object.entries(BOROUGH_COLOR)
    .filter(([name]) => present.has(name))
    .forEach(([name, color]) => swatchRow(nodeKey, color, name, false));

  const mapKey = col('#map-key');
  swatchRow(mapKey, NO_TRIPS_COLOR,    'No trips at this filter', true);
  swatchRow(mapKey, NO_STATIONS_COLOR, 'No Citi Bike stations',   true);
}
