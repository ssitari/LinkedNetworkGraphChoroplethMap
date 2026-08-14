# Linked Network Graph + Choropleth Map

**Work in progress.** A dual-panel D3 visualization pairing a force-directed network graph with a
choropleth map of the same geography. Selecting a node in the network re-colors the map by that node's
edge weights, so the abstract topology of the graph and the real geography of the places it describes
can be read against each other.

The test case is **NYC Citi Bike trips for 2025**, aggregated to Community District Tabulation Areas
(CDTAs). Nodes are CDTAs, edges are trips between them.

Built with [D3.js](https://d3js.org). No build step — plain HTML, CSS, and JavaScript.

---

## Live demo

[View on GitHub Pages](https://ssitari.github.io/LinkedNetworkGraphChoroplethMap/)

---

---

## Status

Early. The core linkage works but the interaction model, styling, and labeling are all unfinished, and
there is no README-worthy documentation of the config surface yet. Pushed for version control and
backup rather than as a finished tool.

The `nta/` folder holds an earlier version of the same idea built on Neighborhood Tabulation Areas
(NTAs) instead of CDTAs. It is superseded by the root version and kept only for reference.

---

## What it does

- **Force-directed network** — one node per CDTA, edges weighted by trip volume between them
- **Linked choropleth** — the map re-colors on interaction to show trip volumes relative to the
  selected node, using a sequential YlGnBu scale
- **Month selector** — steps through the twelve months of 2025
- **Node sizing** — by total trips, departures only, or arrivals only
- **Edge threshold slider** — filters out low-volume edges to make structure visible
- **Borough coloring** — nodes colored by borough when no selection is active

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
3. **`preprocess_network.py`** — the equivalent step for the older NTA version.

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
