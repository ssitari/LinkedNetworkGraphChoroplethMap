"""
preprocess_cdta_network.py

Aggregates od_station_month_dow.csv to CDTA level (month only, no day of week).

Output JSON:
  nodes: [{id, name, short_name, borough}, ...]
    id         = CDTA2020 code  (e.g. "MN03")
    name       = full CDTAName  (e.g. "MN03 Lower East Side-Chinatown (CD 3 Equivalent)")
    short_name = description only, no code prefix or qualifier
                 (e.g. "Lower East Side-Chinatown")
    borough    = borough string

  links: [{s, t, ab: [12], ba: [12]}, ...]
    s, t   = node indices (s < t always)
    ab[k]  = total trips from node s to node t in month k+1
    ba[k]  = total trips from node t to node s in month k+1
    k in 0..11  (January=0 … December=11)
"""

import csv, json, re
from pathlib import Path
from collections import defaultdict

root       = Path(__file__).parent
stations_f = root / "stations_2025.csv"
od_f       = root / "od_station_month_dow.csv"
out_f      = root / "cdta_network_data.json"

# ── Station IDs ──────────────────────────────────────────────────────────────
# Citi Bike IDs look like "6948.10", but wherever an ID is parsed as a number
# the trailing zero is lost and it becomes "6948.1". The 2025 OD table has both
# spellings for the same 101 stations: build_od_tables.py let DuckDB guess
# types file by file, and files read as numeric dropped the zero. Matching
# the raw strings silently dropped ~10% of trips. Restore the second decimal.
def canon(sid):
    return sid + "0" if re.fullmatch(r"\d+\.\d", sid) else sid

# ── Build station → CDTA map ─────────────────────────────────────────────────
station_cdta = {}   # station_id → (cdta_id, cdta_name)
with open(stations_f, newline="", encoding="utf-8") as f:
    for row in csv.DictReader(f):
        sid = canon(row["station_id"])
        station_cdta[sid] = (row["CDTA2020"], row["CDTAName"])

# ── Collect unique CDTAs ──────────────────────────────────────────────────────
cdta_names = {}
for cdta_id, cdta_name in station_cdta.values():
    cdta_names[cdta_id] = cdta_name

nodes_list = sorted(cdta_names.keys())
idx        = {cdta: i for i, cdta in enumerate(nodes_list)}
N          = 12  # months only

def borough(cdta_id):
    prefix = cdta_id[:2]
    return {
        "BK": "Brooklyn", "MN": "Manhattan", "QN": "Queens",
        "BX": "Bronx",    "SI": "Staten Island",
    }.get(prefix, "Other")

def short_name(cdta_id, full_name):
    # Strip leading CDTA code prefix (e.g. "MN03 ")
    stripped = re.sub(r'^[A-Z]{2}\d{2}\s+', '', full_name)
    # Strip trailing qualifier like " (CD 3 Equivalent)" or " (JIA 55 Approximation)"
    stripped = re.sub(r'\s*\([^)]+\)\s*$', '', stripped).strip()
    return stripped or full_name

# ── Aggregate OD trips to CDTA×month ─────────────────────────────────────────
edges = defaultdict(lambda: {"ab": [0] * N, "ba": [0] * N})
skipped = skipped_trips = total_trips = 0

with open(od_f, newline="", encoding="utf-8") as f:
    for row in csv.DictReader(f):
        s_id = canon(row["start_station_id"])
        e_id = canon(row["end_station_id"])
        total_trips += int(row["trip_count"])
        if s_id not in station_cdta or e_id not in station_cdta:
            skipped += 1
            skipped_trips += int(row["trip_count"])
            continue

        s_cdta = station_cdta[s_id][0]
        e_cdta = station_cdta[e_id][0]
        if s_cdta == e_cdta:
            continue  # skip intra-CDTA trips

        k = int(row["month"]) - 1   # 0-indexed month
        c = int(row["trip_count"])

        i, j = idx[s_cdta], idx[e_cdta]
        if i < j:
            edges[(i, j)]["ab"][k] += c
        else:
            edges[(j, i)]["ba"][k] += c

# ── Build output ──────────────────────────────────────────────────────────────
result = {
    "nodes": [
        {
            "id":         cdta,
            "name":       cdta_names[cdta],
            "short_name": short_name(cdta, cdta_names[cdta]),
            "borough":    borough(cdta),
        }
        for cdta in nodes_list
    ],
    "links": [
        {"s": s, "t": t, "ab": v["ab"], "ba": v["ba"]}
        for (s, t), v in sorted(edges.items())
    ],
}

with open(out_f, "w", encoding="utf-8") as f:
    json.dump(result, f, separators=(",", ":"))

size_kb = out_f.stat().st_size / 1024
print(f"Nodes  : {len(result['nodes'])}")
print(f"Links  : {len(result['links'])}")
print(f"Output : {out_f.name} ({size_kb:.1f} KB)")
# Reported as a share of trips, not rows: a silent 10% loss is what the
# ID-spelling bug looked like from here.
if skipped:
    print(f"Skipped: {skipped:,} rows, {skipped_trips:,} trips "
          f"({100 * skipped_trips / total_trips:.2f}%) -- station not in stations_2025.csv")
