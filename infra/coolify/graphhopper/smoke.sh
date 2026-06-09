#!/usr/bin/env bash
# Bordmap R2 GraphHopper smoke (FEN-507) — the ADR completeness criterion.
# Run from INSIDE the Coolify network (the service is never public). Override the
# base URL for a local/host check: GRAPHHOPPER_URL=http://localhost:8989 ./smoke.sh
set -euo pipefail

BASE="${GRAPHHOPPER_URL:-http://bordmap-graphhopper:8989}"
# Two points ~1.2 km apart near Grenoble (FR) — both on the road network.
Q="point=45.188,5.724&point=45.196,5.735&profile=bordmap_road"
Q="${Q}&algorithm=alternative_route&alternative_route.max_paths=3"
Q="${Q}&elevation=true&points_encoded=false&instructions=false"

echo "[smoke] GET ${BASE}/route?${Q}"
body="$(curl -fsS "${BASE}/route?${Q}")" || { echo "[smoke] FAIL: request errored"; exit 1; }

# Assertions: a path exists, coords are 3-tuples (lng,lat,ele), elevation present.
echo "${body}" | grep -q '"paths"'                 || { echo "[smoke] FAIL: no paths[]";   echo "${body}" | head -c 400; exit 1; }
echo "${body}" | grep -Eq '"ascend"[[:space:]]*:'  || { echo "[smoke] FAIL: no ascend";     echo "${body}" | head -c 400; exit 1; }
echo "${body}" | grep -Eq '"descend"[[:space:]]*:' || { echo "[smoke] FAIL: no descend";    echo "${body}" | head -c 400; exit 1; }
# A snapped 3D coordinate looks like [x,y,z] — three numbers in the points array.
echo "${body}" | grep -Eq '\[[-0-9.]+,[-0-9.]+,[-0-9.]+\]' || { echo "[smoke] FAIL: coords not 3D (no elevation in geometry)"; echo "${body}" | head -c 400; exit 1; }

echo "[smoke] PASS: snapped route + elevation returned from ${BASE}"
