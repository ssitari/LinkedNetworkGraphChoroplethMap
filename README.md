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
does and how far apart they are. Fitting

```
log(trips) ~ b0 + b1 * log(mass_i * mass_j) + b2 * log(km)
```

over 2025 gives **R² = 0.898** with a distance exponent near **−3.9** — steep even by gravity-model
standards, which is what you would expect of a bicycle. Distance alone accounts for 68%.

That is a problem for the default view. A force layout weighted by raw trips is arranging nodes by
a quantity that is 90% size and distance, so it settles into a smeared, less legible copy of the map
sitting right next to it. The two panels agree because they are showing the same thing.

**Vs. expected** divides each pair's trips by that prediction and weights the graph by the residual,
so the layout organises around what the model *cannot* explain. The pairs that surface are corridors:
Washington Heights–Inwood connects to the Financial District, Chelsea and the Upper West Side far
more than distance allows, which is the Hudson River Greenway; Williamsburg–Greenpoint to Astoria is
the Pulaski Bridge. None of that is visible when volume drives the encoding.

The model is fitted in the browser over whichever period is selected, on every edge in that period —
not just the ones passing the filter — so moving the filter changes what you see without moving the
yardstick.

Three caveats, all of them visible in the interface:

- **Thin pairs produce nonsense ratios.** A pair with nine trips posted 23× expected in testing. The
  edge filter doubles as the noise floor; raise it before trusting anything.
- **The filter biases the residuals upward.** Residuals average zero across all edges by
  construction, but volume correlates with residual (r = +0.32), so the *visible* set averages about
  1.35× at the default. The map keeps 1× as its neutral point rather than recentring, and the panel
  reports the visible mean so you can read the lean.
- **Residuals are a property of the unordered pair**, so the departures/arrivals control does not
  apply to them; it keeps sizing nodes by trips.

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
