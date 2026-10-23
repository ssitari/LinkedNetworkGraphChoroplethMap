"""
build_od_tables.py

Reads all Citi Bike 2025 trip CSVs, aggregates origin-destination trip counts
by station pair × month × day-of-week, then re-aggregates to NTA level.

Outputs (written to same directory as this script):
  od_station_month_dow.csv  — station-pair level
  od_nta_month_dow.csv      — NTA-pair level (for the D3 viz)

Requirements:
  pip install duckdb
"""

import duckdb
from pathlib import Path

# ── Configure this path ──────────────────────────────────────────────────────
DATA_DIR = r"C:\Users\ericg\Desktop\citi\data"   # folder containing all 53 trip CSVs
# ────────────────────────────────────────────────────────────────────────────

script_dir   = Path(__file__).parent
stations_csv = script_dir / "stations_2025.csv"
out_station  = script_dir / "od_station_month_dow.csv"
out_nta      = script_dir / "od_nta_month_dow.csv"

# DuckDB forward-slash paths required even on Windows
trip_glob    = (Path(DATA_DIR) / "*.csv").as_posix()
stations_str = stations_csv.as_posix()
out_station_str = out_station.as_posix()
out_nta_str     = out_nta.as_posix()

con = duckdb.connect()

# ── Stations lookup ──────────────────────────────────────────────────────────
con.execute(f"""
    CREATE TABLE stations AS
    SELECT station_id,
           NTA2020, NTAName, CDTA2020, CDTAName, MODZCTA, GEOID
    FROM read_csv_auto('{stations_str}', all_varchar=true)
""")
n_stations = con.execute("SELECT COUNT(*) FROM stations").fetchone()[0]
print(f"Stations loaded: {n_stations:,}")

# ── Step 1: aggregate trips at station level ─────────────────────────────────
print(f"\nReading trip files from: {DATA_DIR}")
print("Aggregating by station pair x month x day-of-week")
print("(this will take a few minutes on 50M rows...)\n")

con.execute(f"""
    CREATE TABLE od_station AS
    SELECT
        CAST(start_station_id AS VARCHAR) AS start_station_id,
        CAST(end_station_id   AS VARCHAR) AS end_station_id,
        MONTH(started_at::TIMESTAMP)      AS month,
        DAYOFWEEK(started_at::TIMESTAMP)  AS day_of_week,
        COUNT(*)                          AS trip_count
    -- Station IDs must be read as text. Left to guess, DuckDB types the column
    -- per file, and files read as numeric turn "6948.10" into "6948.1".
    FROM read_csv_auto('{trip_glob}', union_by_name=true, ignore_errors=true,
                       types={{'start_station_id': 'VARCHAR', 'end_station_id': 'VARCHAR'}})
    WHERE start_station_id IS NOT NULL
      AND end_station_id   IS NOT NULL
      AND CAST(start_station_id AS VARCHAR) != CAST(end_station_id AS VARCHAR)
    GROUP BY ALL
    ORDER BY start_station_id, end_station_id, month, day_of_week
""")

n_rows   = con.execute("SELECT COUNT(*)        FROM od_station").fetchone()[0]
n_trips  = con.execute("SELECT SUM(trip_count) FROM od_station").fetchone()[0]
print(f"Trips counted : {n_trips:,}")
print(f"Station-pair x month x day rows: {n_rows:,}")

con.execute(f"COPY od_station TO '{out_station_str}' (HEADER, DELIMITER ',')")
print(f"Written: {out_station.name}\n")

# ── Step 2: join to stations, re-aggregate to NTA level ─────────────────────
print("Joining to stations and re-aggregating to NTA level...")

con.execute(f"""
    CREATE TABLE od_nta AS
    SELECT
        s1.NTA2020         AS start_nta,
        s1.NTAName         AS start_nta_name,
        s2.NTA2020         AS end_nta,
        s2.NTAName         AS end_nta_name,
        od.month,
        od.day_of_week,
        SUM(od.trip_count) AS trip_count
    FROM od_station od
    INNER JOIN stations s1 ON od.start_station_id = s1.station_id
    INNER JOIN stations s2 ON od.end_station_id   = s2.station_id
    GROUP BY ALL
    ORDER BY start_nta, end_nta, month, day_of_week
""")

# Diagnostic: station IDs in trip data not found in stations_2025.csv
unmatched = con.execute("""
    SELECT COUNT(*) FROM od_station od
    WHERE od.start_station_id NOT IN (SELECT station_id FROM stations)
       OR od.end_station_id   NOT IN (SELECT station_id FROM stations)
""").fetchone()[0]
if unmatched > 0:
    print(f"  Note: {unmatched:,} station-pair rows dropped (station ID not in stations_2025.csv)")
    print("  This is normal for stations outside the five boroughs (e.g. Jersey City).")

n_nta_rows  = con.execute("SELECT COUNT(*)        FROM od_nta").fetchone()[0]
n_nta_trips = con.execute("SELECT SUM(trip_count) FROM od_nta").fetchone()[0]

# Count same-NTA rows (self-loops in the network)
n_same_nta = con.execute(
    "SELECT COUNT(*), SUM(trip_count) FROM od_nta WHERE start_nta = end_nta"
).fetchone()

print(f"NTA-pair x month x day rows: {n_nta_rows:,}")
print(f"Trips represented: {n_nta_trips:,}")
print(f"  of which same-NTA (self-loops): {n_same_nta[0]:,} rows / {n_same_nta[1]:,} trips")

con.execute(f"COPY od_nta TO '{out_nta_str}' (HEADER, DELIMITER ',')")
print(f"Written: {out_nta.name}\n")

con.close()
print("Done.")
