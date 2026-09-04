"""
simplify_geojson.py

Thins CDTAs.geojson for web delivery. The source export from QGIS carries ~1,390
vertices per CDTA at 15 decimal places -- roughly 40x more geometry than the map
panel can resolve -- which makes the file 4.4 MB.

Two passes:
  1. Douglas-Peucker simplification at TOLERANCE degrees.
  2. Coordinate rounding to PRECISION decimal places.

TOLERANCE of 0.0001 deg is about 11 m in latitude and 8.5 m in longitude at NYC's
latitude. The map panel renders the whole city in roughly 600 px (~83 m/px), so the
worst-case displacement is about 0.13 px. Rings are simplified independently, so
shared borders between adjacent CDTAs can diverge by up to the tolerance; at this
scale that is sub-pixel. If the map ever becomes zoomable, drop the tolerance.

Usage:
    python simplify_geojson.py            # CDTAs.geojson -> CDTAs.geojson
    python simplify_geojson.py in.geojson out.geojson
"""

import json
import sys
from pathlib import Path

TOLERANCE = 0.0001   # degrees
PRECISION = 5        # decimal places (~1.1 m)
MIN_RING  = 4        # a closed ring needs 3 distinct points plus the closing point


def _perpendicular_distance(p, a, b):
    """Distance from point p to segment a-b. Degenerate segments fall back to
    distance from a, which is what closed rings need on their first split."""
    (x, y), (x1, y1), (x2, y2) = p, a, b
    dx, dy = x2 - x1, y2 - y1
    if dx == 0 and dy == 0:
        return ((x - x1) ** 2 + (y - y1) ** 2) ** 0.5
    t = ((x - x1) * dx + (y - y1) * dy) / (dx * dx + dy * dy)
    t = max(0.0, min(1.0, t))
    return ((x - (x1 + t * dx)) ** 2 + (y - (y1 + t * dy)) ** 2) ** 0.5


def _douglas_peucker(points, tolerance):
    """Iterative Douglas-Peucker. Iterative rather than recursive because some
    CDTA rings run several thousand vertices and would blow the stack."""
    if len(points) < 3:
        return points
    keep = {0, len(points) - 1}
    stack = [(0, len(points) - 1)]
    while stack:
        i, j = stack.pop()
        if j <= i + 1:
            continue
        dmax, idx = 0.0, i
        for k in range(i + 1, j):
            d = _perpendicular_distance(points[k], points[i], points[j])
            if d > dmax:
                dmax, idx = d, k
        if dmax > tolerance:
            keep.add(idx)
            stack.append((i, idx))
            stack.append((idx, j))
    return [points[k] for k in sorted(keep)]


def _simplify_ring(ring, tolerance):
    """Simplify one closed ring, keeping the original if it would collapse."""
    out = _douglas_peucker(ring, tolerance)
    if len(out) < MIN_RING:
        return ring
    if out[0] != out[-1]:
        out.append(out[0])
    return out


def _simplify_geometry(geom, tolerance):
    t = geom["type"]
    if t == "Polygon":
        coords = [_simplify_ring(r, tolerance) for r in geom["coordinates"]]
    elif t == "MultiPolygon":
        coords = [[_simplify_ring(r, tolerance) for r in poly]
                  for poly in geom["coordinates"]]
    else:
        raise ValueError(f"unsupported geometry type: {t}")
    return {"type": t, "coordinates": coords}


def _round(obj, precision):
    if isinstance(obj, float):
        return round(obj, precision)
    if isinstance(obj, list):
        return [_round(v, precision) for v in obj]
    if isinstance(obj, dict):
        return {k: _round(v, precision) for k, v in obj.items()}
    return obj


def _count_vertices(geom):
    polys = [geom["coordinates"]] if geom["type"] == "Polygon" else geom["coordinates"]
    return sum(len(ring) for poly in polys for ring in poly)


def main(src, dst):
    with open(src, encoding="utf-8") as f:
        gj = json.load(f)

    before = after = 0
    for feature in gj["features"]:
        before += _count_vertices(feature["geometry"])
        feature["geometry"] = _simplify_geometry(feature["geometry"], TOLERANCE)
        after += _count_vertices(feature["geometry"])

    gj = _round(gj, PRECISION)

    src_bytes = Path(src).stat().st_size
    with open(dst, "w", encoding="utf-8") as f:
        json.dump(gj, f, separators=(",", ":"))
    dst_bytes = Path(dst).stat().st_size

    print(f"features:  {len(gj['features'])}")
    print(f"vertices:  {before:,} -> {after:,}  ({after / before * 100:.1f}%)")
    print(f"size:      {src_bytes:,} -> {dst_bytes:,} bytes  "
          f"({dst_bytes / src_bytes * 100:.1f}%)")


if __name__ == "__main__":
    root = Path(__file__).parent
    src = sys.argv[1] if len(sys.argv) > 1 else root / "CDTAs.geojson"
    dst = sys.argv[2] if len(sys.argv) > 2 else root / "CDTAs.geojson"
    main(src, dst)
