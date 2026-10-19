# Linked Network Graph + Choropleth Map

A dual-panel D3 visualization pairing a force-directed network graph with a
choropleth map of the same geography. Selecting a node in the network re-colors the map by that node's
edge weights, so the abstract topology of the graph and the real geography of the places it describes
can be read against each other.

The test case is **NYC Citi Bike trips for 2025**, aggregated to Community District Tabulation Areas
(CDTAs). Nodes are CDTAs, edges are trips between them.

Built with [D3.js](https://d3js.org). No build step — plain HTML, CSS, and JavaScript.

---

## Live demo

[View on GitHub Pages](https://ssitari.github.io/LinkedNetworkGraphChoroplethMap/)

Built for desktop. The two panels are meant to be read side by side, so below 760px the page
shows a notice rather than a cramped layout.

---

## Status

Working and published. The geometry, the edge filter, and the node/map labelling have all been
reworked; see the commit history for what changed and why.

The `nta/` folder holds an earlier version of the same idea built on Neighborhood Tabulation Areas
(NTAs) instead of CDTAs. It is superseded by the root version and kept only for reference.

---

## What it does

- **Force-directed network** — one node per CDTA, edges weighted by trip volume between them
- **Linked choropleth** — the map re-colors on interaction to show trip volumes relative to the
  selected node, using a sequential YlGnBu scale
- **Month selector** — steps through the twelve months of 2025
- **Node sizing** — by total trips, departures only, or arrivals only
- **Edge filter** — a percentile slider that hides the weakest edges. It resolves to a trip
  count against whichever period is selected, so the filter stays meaningful when you switch months
- **Borough coloring** — nodes colored by borough when no selection is active
- **Edge weight** — raw trips, or each pair's trips divided by what a gravity model predicts

---

## Edge weight: trips vs. vs-expected

Bike trips between two districts are almost entirely a function of how much cycling each
does and how far apart they are. That is a problem for the default view. A force layout weighted by
raw trips is arranging nodes by a quantity that is mostly size and distance, so it settles into a
smeared, less legible copy of the map sitting right next to it. The two panels agree because they
are showing the same thing.

**Vs. expected** fits a gravity model, divides each pair's trips by what it predicts, and weights
the graph by the result, so the layout organises around what the model *cannot* explain.

### The model

A Poisson regression over every pair of districts, including pairs with no trips:

```
log E[trips_ij] = a_i + a_j + f(km_ij)
```

- **`a_i`, `a_j`** — one term per district. They absorb how much cycling each district does, so
  every district's expected total equals its actual total. What is left over says only *who* a
  district trades with, never *how much* it rides.
- **`f(km)`** — distance between district centroids, as a piecewise-linear curve in log(km) that
  can bend at 2, 4, 8 and 16 km. A single power law cannot fit both ends: the curve that fits the
  busy short pairs decays too slowly at range. For 2025 the fitted slope is roughly flat under 2 km,
  then steepens to −1.7, −3.6, −4.2 and −5.8 by segment — about what you would expect of a bicycle.

Over 2025 the model explains **95.7% of the deviance** (the Poisson analogue of R²), and actual and
expected trips agree to within about 10% in every distance band out to 20 km.

The model is fitted in the browser, by Newton-Raphson, over whichever period is selected and every
pair in it — not just the edges passing the filter — so moving the filter changes what you see
without moving the yardstick.

### What it shows

Over-connected pairs (orange edges, red on the map) are corridors. Washington Heights–Inwood rides to
the Financial District at 11.6× expected, and to Chelsea, SoHo and Midtown at 4–5×: that is the
Hudson River Greenway. Williamsburg–Greenpoint to Astoria runs at 2.1×, across the Pulaski Bridge.

Under-connected pairs (blue) are mostly water. Harlem, East Harlem and Mott Haven to Astoria sit at
0.1× — close as the crow flies, a long way by bike. Park Slope to the Financial District is 0.17×.

With nothing selected, the map shows each district's **typical miss**: the trip-weighted average of
how far its pairs sit from expected, as a factor. It is highest where straight-line distance is the
poorest guide to where riders go — Washington Heights, Astoria, Long Island City, Mott Haven.

### Caveats

- **Thin pairs produce nonsense ratios.** A pair with a handful of trips can post 20× or 0.05×
  and mean nothing. The edge filter doubles as the noise floor; raise it before trusting anything.
- **The filter can tilt the visible set.** Across every pair, actual and expected totals match
  exactly. But a long-distance pair only clears a volume cutoff if it is beating its prediction, so
  the visible set can lean over 1× — 1.00× at the default filter, 1.05× at the 90th percentile. The
  map keeps 1× as its neutral point, and the panel reports the visible ratio so you can read the lean.
- **Centroid distance is not route distance.** Rivers and bridges are invisible to the model, which
  is why so many of the strongest residuals are about water.
- **Residuals are a property of the unordered pair**, so the departures/arrivals control does not
  apply to them; it keeps sizing nodes by trips.
- **The geography is coarse for bike trips.** The median Citi Bike trip is about 1.6 km in a straight
  line, and 34% of trips start and end in the same CDTA, so they never appear in the network.

---

## Running locally

The app loads its data via `fetch()`, so it must be served over HTTP:

```bash
python3 -m http.server 8000
# then open http://localhost:8000
```

---

## Data pipeline

The two raw origin-destination CSVs are excluded from the repository by `.gitignore` — the
station-level file is roughly 400 MB. To regenerate them:

1. **`build_od_tables.py`** — reads the 2025 Citi Bike trip CSVs with
   [DuckDB](https://duckdb.org) and aggregates ~50M trips to origin-destination counts by station pair
   × month × day of week, then re-aggregates to NTA level. Set the `DATA_DIR` constant at the top of
   the script to wherever your trip CSVs live.
2. **`preprocess_cdta_network.py`** — rolls the station-level table up to CDTA × month and writes
   `cdta_network_data.json`, the file the visualization actually loads. Intra-CDTA trips are dropped.
3. **`nta/preprocess_network.py`** — the equivalent step for the older NTA version, reading
   `od_nta_month_dow.csv` and writing `nta/network_data.json`.
4. **`simplify_geojson.py`** — thins `CDTAs.geojson` for web delivery. The raw QGIS export is
   4.4 MB: ~1,390 vertices per CDTA at 15 decimal places, roughly 40x more geometry than the map
   panel can resolve. Douglas-Peucker at 0.0001 deg (~11 m, about 0.13 px at the rendered scale)
   plus rounding to 5 decimal places brings it to 262 KB — 12% of the vertices, 6% of the bytes.
   All 71 features, 208 rings, and every property are preserved; median area change is 0.04%.
   Re-run it after any re-export from QGIS.

`stations_2025.csv` is the station lookup table, mapping each Citi Bike station ID to its NTA, CDTA,
MODZCTA, and census tract GEOID. `CDTAs.qmd` is the QGIS project used to prepare `CDTAs.geojson`.

---

## Data sources

**Trip data:** [Citi Bike System Data](https://citibikenyc.com/system-data), 2025 trip histories.
Licensed under the [NYCBS Data Use Policy](https://ride.citibikenyc.com/data-sharing-policy).

**Geography:** Community District Tabulation Areas (2020) from the
[NYC Department of City Planning](https://www.nyc.gov/site/planning/data-maps/open-data.page).
Station-to-geography assignments computed by spatial join in [QGIS](https://qgis.org).

---

## Libraries

| Library | Use | License |
|---|---|---|
| [D3.js v7](https://d3js.org) | Visualization, force simulation, mapping | ISC |
| [DuckDB](https://duckdb.org) | Trip data aggregation (preprocessing only) | MIT |

---

## Acknowledgements

Most of the code written with assistance from [Claude](https://claude.ai) (Anthropic).

---

## License

MIT — free to use, adapt, and redistribute with attribution.
