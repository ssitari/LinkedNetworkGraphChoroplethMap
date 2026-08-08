"""
preprocess_network.py

Converts od_nta_month_dow.csv into network_data.json for the D3 force network.

Output structure:
  nodes: [{id, name, borough}, ...]
  links: [{s, t, ab: [84], ba: [84]}, ...]
    s, t  = node indices (s < t always)
    ab[k] = trips from node s to node t in period k
    ba[k] = trips from node t to node s in period k
    k     = (month - 1) * 7 + day_of_week  (0-83)
            months 1-12, day_of_week 0-6 (0=Sunday per DuckDB DAYOFWEEK)
"""

import csv, json
from pathlib import Path
from collections import defaultdict

src = Path(__file__).parent / "od_nta_month_dow.csv"
out = Path(__file__).parent / "network_data.json"

# Build NTA name map
nta_names = {}
with open(src, newline="", encoding="utf-8") as f:
    for row in csv.DictReader(f):
        nta_names[row["start_nta"]] = row["start_nta_name"]
        nta_names[row["end_nta"]]   = row["end_nta_name"]

nodes = sorted(nta_names.keys())
idx   = {nta: i for i, nta in enumerate(nodes)}
N     = 84  # 12 months x 7 days

def borough(nta_id):
    prefix = nta_id[:2]
    return {"BK": "Brooklyn", "MN": "Manhattan", "QN": "Queens",
            "BX": "Bronx",    "SI": "Staten Island"}.get(prefix, "Other")

# Accumulate directed trip counts per NTA pair x period
edges = defaultdict(lambda: {"ab": [0] * N, "ba": [0] * N})

with open(src, newline="", encoding="utf-8") as f:
    for row in csv.DictReader(f):
        s, e = row["start_nta"], row["end_nta"]
        if s == e:
            continue
        k = (int(row["month"]) - 1) * 7 + int(row["day_of_week"])
        c = int(row["trip_count"])
        i, j = idx[s], idx[e]
        if i < j:
            edges[(i, j)]["ab"][k] += c
        else:
            edges[(j, i)]["ba"][k] += c

result = {
    "nodes": [{"id": nta, "name": nta_names[nta], "borough": borough(nta)}
              for nta in nodes],
    "links": [{"s": s, "t": t, "ab": v["ab"], "ba": v["ba"]}
              for (s, t), v in sorted(edges.items())],
}

with open(out, "w", encoding="utf-8") as f:
    json.dump(result, f, separators=(",", ":"))

size_mb = out.stat().st_size / 1024 / 1024
print(f"Nodes : {len(result['nodes'])}")
print(f"Links : {len(result['links'])}")
print(f"Output: {out.name} ({size_mb:.1f} MB)")
