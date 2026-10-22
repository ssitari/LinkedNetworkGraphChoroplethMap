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

// Residual encoding. Edges get flat warm/cool by sign with opacity carrying the
// magnitude, rather than a diverging ramp: a ramp's pale midpoint would make the
// least interesting edges the brightest things on a dark ground.
const EDGE_OVER  = '#f0a04b';
const EDGE_UNDER = '#5b8fc9';

// Classed fills, shared by the map and the network's node fills under a
// selection. Counts and typical miss are sequential: Brewer YlGnBu, five
// quantile classes over the values in view, so every class is used whatever
// the period or filter. Vs. expected is diverging about 1x, so it takes Brewer
// RdBu with fixed breaks symmetric in log space (0.5 and 2 sit equally far
// from 1); the middle class reads "about as expected". Reversed so
// over-connected is warm, like the edges.
const SEQ_COLORS   = d3.schemeYlGnBu[5];
const DIV_COLORS   = [...d3.schemeRdBu[5]].reverse();
const RATIO_BREAKS = [0.5, 0.8, 1.25, 2];

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
  edgeMetric:  'trips',  // 'trips' | 'residual'
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
let   viewClasses  = null;  // the classes on the map now -- highlight() colors nodes by them

// Falls back to nominal dimensions: below the 760px breakpoint the panels are
// display:none and measure 0, which would centre the simulation on the origin.
function dims() {
  const r = container.getBoundingClientRect();
  return { w: r.width || 900, h: r.height || 700 };
}

svg.call(
  d3.zoom().scaleExtent([0.2, 10])
    .on('zoom', e => {
      g.attr('transform', e.transform);
      // Panning changes which boxes fall inside the panel, and zoom/pan does not
      // wake the simulation, so nothing else would re-place them.
      refreshLabels();
    })
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
    // forceCenter recentres but does not compress. Weakening link strength in
    // residual mode lets charge push the graph wider than the panel, which
    // clipped labels off both edges, so a mild pull toward the middle bounds it.
    // Stronger on x because the panel is far taller than it is wide.
    .force('x',         d3.forceX(w / 2).strength(0.07))
    .force('y',         d3.forceY(h / 2).strength(0.03))
    .force('collision', d3.forceCollide(10))
    .alphaDecay(0.02)
    .on('tick', ticked);

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
      simulation.force('x').x(w / 2);
      simulation.force('y').y(h / 2);
      simulation.alpha(0.3).restart();
    }
    if (onMapResize) onMapResize();
  }, 150);
});

// ── Gravity model ─────────────────────────────────────────────────────────────
// Trips between two districts are overwhelmingly a function of how much cycling
// each does and how far apart they are -- for 2025 that explains ~96% of the
// deviance. A force layout weighted by raw trips is therefore mostly redrawing
// the map beside it. Fitting that expectation and showing the residual leaves
// the part the map cannot tell you: which pairs ride together far more, or far
// less, than their size and separation predict.
//
// Poisson regression: log E[trips_ij] = a_i + a_j + f(km_ij). Each district gets
// its own term, so a district's expected total always equals its actual total
// and the residuals say only *who* it trades with, not how much. It is fitted on
// every pair of active districts, zeros included. An earlier log-linear OLS fit
// had to drop the zeros and fitted a geometric mean, so its expected trips summed
// to six times the real total.
//
// f is piecewise linear in log(km), bending at DIST_KNOTS_KM. A single power
// law cannot fit both ends: weighted toward the big short pairs it decays too
// slowly at range, and vice versa. For 2025 the slope runs from ~0 under 2 km to
// ~-5.8 beyond 16 km, which is what a bicycle would lead you to expect.
//
// ~48 parameters over at most 903 rows, solved by Newton-Raphson directly
// rather than pulling in a regression library.
const DIST_KNOTS_KM = [2, 4, 8, 16];
const LOG_KNOTS     = DIST_KNOTS_KM.map(Math.log);

let centroids  = {};    // CDTA2020 -> [lon, lat]
let gravityFit = null;  // { dev, n, slopes } once fitted

function computeCentroids(geo) {
  geo.features.forEach(f => {
    const polys = f.geometry.type === 'Polygon'
      ? [f.geometry.coordinates] : f.geometry.coordinates;
    let ax = 0, ay = 0, aa = 0;
    for (const poly of polys) {
      const ring = poly[0];
      for (let i = 0; i < ring.length - 1; i++) {
        const [x1, y1] = ring[i], [x2, y2] = ring[i + 1];
        const cross = x1 * y2 - x2 * y1;
        aa += cross; ax += (x1 + x2) * cross; ay += (y1 + y2) * cross;
      }
    }
    if (aa) centroids[f.properties.CDTA2020] = [ax / (3 * aa), ay / (3 * aa)];
  });
}

function centroidKm(idA, idB) {
  const a = centroids[idA], b = centroids[idB];
  if (!a || !b) return 0;
  const midLat = (a[1] + b[1]) / 2 * Math.PI / 180;
  return Math.hypot((b[0] - a[0]) * 111.32 * Math.cos(midLat),
                    (b[1] - a[1]) * 110.57);
}

// Gaussian elimination with partial pivoting.
function solveN(M, v) {
  const n = v.length;
  const a = M.map((row, i) => [...row, v[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(a[r][c]) > Math.abs(a[p][c])) p = r;
    if (Math.abs(a[p][c]) < 1e-12) return null;
    [a[c], a[p]] = [a[p], a[c]];
    for (let r = 0; r < n; r++) {
      if (r === c || !a[r][c]) continue;
      const k = a[r][c] / a[c][c];
      for (let j = c; j <= n; j++) a[r][j] -= k * a[c][j];
    }
  }
  return a.map((row, i) => row[n] / row[i]);
}

// log(km) plus one hinge per knot: the slope changes at each knot, the curve
// does not jump.
function distanceBasis(km) {
  const ld = Math.log(km);
  return [ld, ...LOG_KNOTS.map(k => Math.max(0, ld - k))];
}

// Fitted over every pair in the period, not just the edges on screen, so dragging
// the filter changes what you see without moving the yardstick you see it against.
function computeGravity(links) {
  const n = simNodes.length;
  const mass   = new Float64Array(n);
  const byPair = new Map();
  for (const l of links) {
    mass[l.s] += l.total; mass[l.t] += l.total;
    byPair.set(Math.min(l.s, l.t) * n + Math.max(l.s, l.t), l);
    l.resid = 0; l.ratio = 1; l.expected = null;
  }

  // Every pair of active districts, including those with no trips at all: a zero
  // is an observation, and leaving zeros out flatters every pair that has trips.
  const active = d3.range(n).filter(i => mass[i] > 0 && centroids[simNodes[i].id]);
  const m = active.length, K = 1 + LOG_KNOTS.length, P = m + K;
  const rows = [];
  for (let a = 0; a < m; a++) {
    for (let b = a + 1; b < m; b++) {
      const i = active[a], j = active[b];
      const km = centroidKm(simNodes[i].id, simNodes[j].id);
      if (km <= 0) continue;
      const l = byPair.get(i * n + j);
      rows.push({ a, b, x: distanceBasis(km), y: l ? l.total : 0, l });
    }
  }
  if (rows.length < P + 10) { gravityFit = null; return; }

  const eta = (t, r) => {
    let e = t[r.a] + t[r.b];
    for (let q = 0; q < K; q++) e += t[m + q] * r.x[q];
    return e;
  };
  const logLik = t => {
    let s = 0;
    for (const r of rows) { const e = eta(t, r); s += r.y * e - Math.exp(e); }
    return s;
  };

  // Start from no distance decay, with each district's term set so its trips
  // roughly balance; Newton then converges in about ten steps.
  let theta = new Float64Array(P);
  const half = 0.5 * Math.log(d3.sum(mass));
  active.forEach((i, k) => { theta[k] = Math.log(mass[i]) - half; });
  let ll = logLik(theta);

  for (let iter = 0; iter < 50; iter++) {
    const g = new Float64Array(P);
    const H = Array.from({ length: P }, () => new Float64Array(P));
    for (const r of rows) {
      const mu = Math.exp(eta(theta, r)), res = r.y - mu;
      const idx = [r.a, r.b], x = [1, 1];
      for (let q = 0; q < K; q++) { idx.push(m + q); x.push(r.x[q]); }
      for (let p = 0; p < idx.length; p++) {
        g[idx[p]] += x[p] * res;
        for (let q = 0; q < idx.length; q++) H[idx[p]][idx[q]] += mu * x[p] * x[q];
      }
    }
    const step = solveN(H.map(row => Array.from(row)), Array.from(g));
    if (!step) { gravityFit = null; return; }

    // Halve the step until it improves the likelihood. Near the optimum rounding
    // can stop any step from improving it, which is convergence too.
    let s = 1, next = null;
    for (; s > 1e-6; s /= 2) {
      const cand = theta.map((v, k) => v + s * step[k]);
      const llc = logLik(cand);
      if (llc >= ll) { next = cand; ll = llc; break; }
    }
    if (!next) break;
    theta = next;
    if (d3.max(step, Math.abs) * s < 1e-9) break;
  }

  // Deviance explained: the Poisson analogue of R², against a model that
  // predicts the same count for every pair.
  let dev = 0, dev0 = 0;
  const ybar = d3.mean(rows, r => r.y);
  for (const r of rows) {
    const mu = Math.exp(eta(theta, r));
    dev  += 2 * ((r.y ? r.y * Math.log(r.y / mu)   : 0) - (r.y - mu));
    dev0 += 2 * ((r.y ? r.y * Math.log(r.y / ybar) : 0) - (r.y - ybar));
    if (r.l) {
      r.l.expected = mu;
      r.l.ratio    = r.y / mu;
      r.l.resid    = Math.log(r.l.ratio);
    }
  }
  // The distance-decay slope within each segment, between successive knots.
  const slopes = d3.range(K).map(q => d3.sum(theta.subarray(m, m + q + 1)));
  gravityFit = { dev: dev0 ? 1 - dev / dev0 : 0, n: rows.length, slopes };
}

// How far off the model typically is for a district's trips: the trip-weighted
// mean |log(actual / expected)| over the edges on show, as a factor. With every
// district's total pinned to its actual, "does this place beat its geography
// overall" no longer has an answer; this is the overview question that does.
function missByNode() {
  const n = simNodes.length;
  const w = new Float64Array(n), s = new Float64Array(n);
  for (const l of rawWeighted) {
    if (l.total < state.threshold || l.expected === null) continue;
    const a = l.total * Math.abs(l.resid);
    s[l.s] += a; w[l.s] += l.total;
    s[l.t] += a; w[l.t] += l.total;
  }
  return Array.from(w, (wi, i) => wi ? Math.exp(s[i] / wi) : null);
}

const useResidual = () => state.edgeMetric === 'residual';

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
  computeGravity(rawWeighted);
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

  // Symmetric domain so an edge twice its expectation and one at half of it read
  // as equally far from neutral.
  const maxResid = d3.max(activeLinks, l => Math.abs(l.resid || 0)) || 1;
  // Raw trips are so skewed that a sqrt ramp left most edges hairline and a few
  // thick. Residuals in log space are near-normal, so the same ramp gave almost
  // every edge mid weight and turned the graph into one orange mass. Exponents
  // above 1 put the ink back on the outliers.
  const residWidth   = d3.scalePow().exponent(1.6)
    .domain([0, maxResid]).range([0.3, 8]).clamp(true);
  const residOpacity = d3.scalePow().exponent(2)
    .domain([0, maxResid]).range([0.03, 0.85]).clamp(true);

  const simLinks = activeLinks.map(l => ({ ...l, source: l.s, target: l.t }));

  // ── Links ──
  const linkSel = linkLayer.selectAll('line')
    .data(simLinks, l => `${l.s}-${l.t}`);

  linkSel.enter().append('line')
    .merge(linkSel)
    .attr('stroke', l => !useResidual() ? '#888'
      : (l.resid || 0) >= 0 ? EDGE_OVER : EDGE_UNDER)
    .attr('stroke-opacity', l => useResidual()
      ? residOpacity(Math.abs(l.resid || 0)) : 0.35)
    .attr('stroke-width', l => useResidual()
      ? residWidth(Math.abs(l.resid || 0)) : wScale(l.total));

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
      showTooltip(event, d);  // the open tooltip's content depends on the selection
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

  // The layout follows the active metric, which is the whole point: under trips
  // it settles into a smeared copy of the map; under residual the pairs that beat
  // their geography should pull together instead. Distance alone did not do it --
  // 400+ links of equal strength collapse into a ball however far apart you ask
  // them to sit -- so strength is scaled too, leaving unsurprising pairs barely
  // able to influence where anything goes. Both are multiples of d3's own
  // 1/min(degree) default, which is what keeps hub nodes from tearing loose.
  const deg = new Float64Array(simNodes.length);
  for (const l of simLinks) { deg[l.s]++; deg[l.t]++; }
  const baseStrength = l => 1 / Math.max(1, Math.min(deg[l.s], deg[l.t]));

  simulation.force('link')
    .distance(l => useResidual()
      ? 130 - 85 * Math.max(0, l.resid || 0) / maxResid
      : 80)
    .strength(l => useResidual()
      ? baseStrength(l) * (0.05 + 0.95 * Math.max(0, l.resid || 0) / maxResid)
      : baseStrength(l))
    .links(simLinks);
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

// Labels live inside the zoom group, so a box that is fine in layout coordinates
// can still be off-screen. Project through the live transform and require the whole
// box to land inside the panel -- a half-clipped label is worse than none, and when
// zoomed in this correctly stops labelling nodes that have scrolled out of view.
function insidePanel(r) {
  const t = d3.zoomTransform(svg.node());
  const { w, h } = dims();
  return t.applyX(r.x0) >= 2 && t.applyX(r.x1) <= w - 2 &&
         t.applyY(r.y0) >= 2 && t.applyY(r.y1) <= h - 2;
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
      if (!insidePanel(r)) continue;
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

  // The same value the map shows for each partner, so a node and its district
  // fall in the same class. Residual is a property of the unordered pair, so the
  // departures/arrivals split does not apply to it -- that control keeps sizing
  // nodes by trips.
  const valueMap = {};
  for (const l of adjLinks) {
    const isSource = l.source.index === node.index;
    const otherIdx = isSource ? l.target.index : l.source.index;
    valueMap[otherIdx] = useResidual() ? l.ratio
      : state.mode === 'total' ? l.total
      : state.mode === 'from' ? (isSource ? l.ab : l.ba)
      : (isSource ? l.ba : l.ab);
  }

  nodeLayer.selectAll('g.node')
    .attr('opacity', d => neighborSet.has(d.index) ? 1 : FADED_OPACITY);

  nodeLayer.selectAll('g.node circle')
    .attr('fill', d => {
      const v = valueMap[d.index];
      return d.index !== node.index && v && viewClasses
        ? viewClasses.color(v)
        : (BOROUGH_COLOR[d.borough] || DEFAULT_COLOR);
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
// The tooltip answers the question the screen is asking. With a district
// selected, hovering any other one shows only the trips between the two --
// its totals with everyone would contradict the map, which is colored by the
// pair. Otherwise it shows the district's totals over the edges on show, and
// says so, since with the filter on that is not "everywhere".
function showTooltip(event, d) {
  const header = `<strong>${d.id}</strong><br>${d.short_name}<br>${d.borough}<br>`;
  const html = selectedNode && selectedNode.index !== d.index
    ? header + pairTooltip(selectedNode, d)
    : header + totalsTooltip(d);
  tooltip.style('display', 'block').html(html);
  moveTooltip(event);
}

function totalsTooltip(d) {
  // Reads rawWeighted, already reduced to the selected period, and applies the
  // same threshold as the draw -- so these totals match what is on screen.
  let out = 0, inn = 0, n = 0;
  for (const l of rawWeighted) {
    if (l.total < state.threshold) continue;
    if      (l.s === d.index) { out += l.ab; inn += l.ba; n++; }
    else if (l.t === d.index) { out += l.ba; inn += l.ab; n++; }
  }
  const scope = selectedNode ? 'highlighted' : 'connected';
  let html =
    `<span class="tt-sub">Trips with the ${n} ${scope} district${n === 1 ? '' : 's'}</span><br>` +
    `Departures: ${out.toLocaleString()}<br>` +
    `Arrivals: &nbsp;${inn.toLocaleString()}<br>` +
    `Total: &nbsp;&nbsp;&nbsp;&nbsp;${(out + inn).toLocaleString()}`;
  if (useResidual()) {
    const miss = missByNode()[d.index];
    if (miss !== null) html += `<br>Typical miss vs. expected: ${miss.toFixed(2)}×`;
  }
  return html;
}

// Directions are named from the selected district, matching the map legend
// ("Departures — MN12" colors each partner by trips from MN12).
function pairTooltip(sel, d) {
  let html = `<span class="tt-sub">Trips with ${sel.short_name} (${sel.id})</span><br>`;
  const l = rawWeighted.find(l =>
    (l.s === sel.index && l.t === d.index) || (l.s === d.index && l.t === sel.index));
  if (!l) {
    const when = state.month ? `${MONTHS[state.month]} 2025` : '2025';
    return html + `None in ${when}`;
  }
  const fromSel = l.s === sel.index ? l.ab : l.ba;
  const toSel   = l.s === sel.index ? l.ba : l.ab;
  html +=
    `From ${sel.id}: ${fromSel.toLocaleString()}<br>` +
    `To ${sel.id}: &nbsp;&nbsp;&nbsp;${toSel.toLocaleString()}<br>` +
    `Total: &nbsp;&nbsp;&nbsp;&nbsp;${l.total.toLocaleString()}`;
  if (useResidual() && l.expected !== null) {
    html += `<br>Expected: ${Math.round(l.expected).toLocaleString()} ` +
            `(${l.ratio.toFixed(2)}×)`;
  }
  if (l.total < state.threshold) {
    html += `<br><span class="tt-sub">Below the edge filter ` +
            `(≥${state.threshold.toLocaleString()}), so not drawn</span>`;
  }
  return html;
}
function moveTooltip(event) {
  tooltip.style('left', (event.pageX + 14) + 'px').style('top', (event.pageY - 32) + 'px');
}
function hideTooltip() { tooltip.style('display', 'none'); }

// ── Stats ──────────────────────────────────────────────────────────────────────
function updateStats(edges, nodes) {
  document.getElementById('stat-edges').textContent = edges.toLocaleString();
  document.getElementById('stat-nodes').textContent = nodes;
  document.getElementById('stat-fit').textContent =
    gravityFit ? gravityFit.dev.toFixed(3) : '\u2014';

  // Over every pair, actual and expected totals match exactly -- the district
  // terms guarantee it. But the filter keeps edges by trip volume, and a pair
  // only clears a volume cutoff at long range if it is beating its prediction,
  // so the visible set can lean over 1x. Recentring the ramp would bury that;
  // reporting the ratio of totals lets you read the map knowing which way it leans.
  let y = 0, mu = 0;
  for (const l of rawWeighted) {
    if (l.total < state.threshold || l.expected === null) continue;
    y += l.total; mu += l.expected;
  }
  document.getElementById('stat-bias').textContent =
    mu ? (y / mu).toFixed(2) + '\u00d7' : '\u2014';
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
    computeGravity(rawWeighted);
    recomputeThresholdScale(rawWeighted);
    applyThresholdAndDraw(data);
  });

  d3.selectAll('input[name="mode"]').on('change', function () {
    state.mode = this.value;
    applyThresholdAndDraw(data);
  });

  d3.selectAll('input[name="edge"]').on('change', function () {
    state.edgeMetric = this.value;
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
  computeCentroids(geo);

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
      showTooltip(event, node);  // the open tooltip's content depends on the selection
    });

  onMapResize = () => {
    const nr = mapContainer.getBoundingClientRect();
    if (!nr.width || !nr.height) return;
    projection.fitSize([nr.width, nr.height], geo);
    mapG.selectAll('path').attr('d', path);
  };
}

// ── Classes ───────────────────────────────────────────────────────────────────
const fmtCount = v => Math.round(v).toLocaleString();
const fmtRatio = v => (v >= 10 ? v.toFixed(1) : v.toFixed(2)) + '\u00d7';

// Bins the values in view by the class each falls in, so every label gives the
// range actually on screen rather than the class's theoretical bounds.
function classRows(values, scale, colors, fmt, keepEmpty) {
  return colors.map(color => {
    const inClass = values.filter(v => scale(v) === color);
    if (!inClass.length) return keepEmpty ? { color, label: 'none in view' } : null;
    const [lo, hi] = d3.extent(inClass);
    return { color, label: fmt(lo) === fmt(hi) ? fmt(lo) : `${fmt(lo)} \u2013 ${fmt(hi)}` };
  }).filter(Boolean);
}

// With nothing in view -- a district whose edges the filter has hidden -- the
// legend says so once instead of listing five empty classes.
const NO_CLASSES = { color: () => null, rows: [], note: 'No trips at this filter' };

// Empty classes are dropped: with fewer than five distinct values in view,
// quantiles repeat, and a row labelled "none" would only be noise.
function quantileClasses(values, fmt) {
  if (!values.length) return NO_CLASSES;
  const scale = d3.scaleQuantile().domain(values).range(SEQ_COLORS);
  return { color: scale, rows: classRows(values, scale, SEQ_COLORS, fmt, false),
           note: 'Quantile classes' };
}

// Empty classes are kept: the breaks are fixed, and an empty "about as
// expected" class is itself worth seeing.
function ratioClasses(values) {
  if (!values.length) return NO_CLASSES;
  const scale = d3.scaleThreshold().domain(RATIO_BREAKS).range(DIV_COLORS);
  return { color: scale, rows: classRows(values, scale, DIV_COLORS, fmtRatio, true),
           note: 'Breaks at 0.5, 0.8, 1.25 and 2\u00d7' };
}

// ── Legends ───────────────────────────────────────────────────────────────────
// One per panel, rebuilt with the map on every change of selection, period,
// filter or metric, so each always describes what is on screen.
const mapLegend = d3.select('#map-container').append('div').attr('class', 'panel-legend');
const netLegend = d3.select('#chart-container').append('div').attr('class', 'panel-legend');

// sections: [{ title?, note?, rows: [{ color, label, shape, outline? }] }]
function renderLegend(el, sections) {
  el.html('');
  for (const s of sections) {
    const sec = el.append('div').attr('class', 'lg-section');
    if (s.title) sec.append('div').attr('class', 'lg-title').text(s.title);
    if (s.note)  sec.append('div').attr('class', 'lg-note').text(s.note);
    for (const r of s.rows) {
      const row = sec.append('div').attr('class', 'lg-row');
      row.append('span').attr('class', `lg-sw ${r.shape}`)
        .style('background', r.color)
        .style('border-color', r.outline || null);
      row.append('span').text(r.label);
    }
  }
}

function legendTitle(sel) {
  if (useResidual()) {
    return sel ? `Vs. expected: trips with ${sel.short_name}` : 'Typical miss vs. expected';
  }
  if (sel) {
    const verb = state.mode === 'from' ? 'from' : state.mode === 'to' ? 'to' : 'with';
    return `Trips ${verb} ${sel.short_name}`;
  }
  return state.mode === 'from' ? 'Departures per district'
    :    state.mode === 'to'   ? 'Arrivals per district'
    :                            'Trips per district';
}

function updateLegends(sel, valueMap) {
  const title = legendTitle(sel);
  const shaped = (rows, shape) => rows.map(r => ({ ...r, shape }));
  const selectedRow = sel && {
    label: `${sel.short_name} (selected)`,
    color: BOROUGH_COLOR[sel.borough] || DEFAULT_COLOR,
    outline: '#fff',
  };

  // Map: the classes, then the selection and the two greys that are not data.
  // "No trips shown" only appears when some served district is actually grey.
  const unshown = simNodes.some(n => n.id !== selectedId && !(n.id in valueMap));
  renderLegend(mapLegend, [
    { title, note: viewClasses.note, rows: shaped(viewClasses.rows, 'square') },
    { rows: shaped([
        ...(selectedRow ? [selectedRow] : []),
        ...(unshown ? [{ label: 'No trips shown', color: NO_TRIPS_COLOR }] : []),
        { label: 'No Citi Bike stations', color: NO_STATIONS_COLOR },
      ], 'square') },
  ]);

  // Network: under a selection the partner nodes take the map's classes;
  // otherwise nodes are colored by borough. In vs. expected mode the edges
  // carry their own warm/cool key.
  const present = new Set(simNodes.map(n => n.borough));
  const sections = [sel
    ? { title, note: viewClasses.note,
        rows: shaped([...viewClasses.rows, selectedRow], 'circle') }
    : { title: 'Borough',
        rows: shaped(Object.entries(BOROUGH_COLOR)
          .filter(([b]) => present.has(b))
          .map(([label, color]) => ({ label, color })), 'circle') }];
  if (useResidual()) {
    sections.push({ title: 'Edges', note: 'Thicker = further from expected', rows: shaped([
      { label: 'More trips than expected', color: EDGE_OVER },
      { label: 'Fewer trips than expected', color: EDGE_UNDER },
    ], 'line') });
  }
  renderLegend(netLegend, sections);
}

// ── Choropleth ────────────────────────────────────────────────────────────────
function updateChoropleth(selectedIndex) {
  if (!mapG.selectAll('path').size()) return;

  selectedId = selectedIndex === null ? null : simNodes[selectedIndex].id;
  const sel  = selectedIndex === null ? null : simNodes[selectedIndex];

  // One value per district. With a district picked: each partner's trips with
  // it, or their ratio to expected. With none: each district's own total, or
  // its typical miss (see missByNode), which is high where distance is a poor
  // guide to where its riders go. Zeros are left out and drawn grey.
  const valueMap = {};
  if (!sel) {
    const own = useResidual() ? missByNode() : Array.from(lastMetrics || []);
    simNodes.forEach(n => { if (own[n.index]) valueMap[n.id] = own[n.index]; });
  } else {
    for (const l of rawWeighted) {
      if (l.total < state.threshold) continue;
      const fromSel = l.s === selectedIndex;
      if (!fromSel && l.t !== selectedIndex) continue;
      const v = useResidual()            ? l.ratio
        :       state.mode === 'from'    ? (fromSel ? l.ab : l.ba)
        :       state.mode === 'to'      ? (fromSel ? l.ba : l.ab)
        :                                  l.total;
      if (v) valueMap[simNodes[fromSel ? l.t : l.s].id] = v;
    }
  }

  const values = Object.values(valueMap);
  viewClasses = useResidual() && sel ? ratioClasses(values)
    : quantileClasses(values, useResidual() ? fmtRatio : fmtCount);

  mapG.selectAll('path')
    .attr('fill', f => {
      const id = f.properties.CDTA2020;
      if (id === selectedId) return BOROUGH_COLOR[f.properties.BoroName] || DEFAULT_COLOR;
      if (id in valueMap) return viewClasses.color(valueMap[id]);
      return geoIdToIndex[id] === undefined ? NO_STATIONS_COLOR : NO_TRIPS_COLOR;
    })
    .attr('stroke', f => f.properties.CDTA2020 === selectedId ? '#fff' : '#444')
    .attr('stroke-width', pathStrokeWidth);

  updateLegends(sel, valueMap);
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
