#!/usr/bin/env bash
# FEN-1315 / FEN-1310 AC-4 — Gourguillon (Vieux-Lyon) route proof.
#
# Proves the pedestrian-parity custom_model fix makes GraphHopper actually ROUTE
# over the Montée du Gourguillon (OSM way 1233389877, highway=pedestrian,
# surface=unhewn_cobblestone, maxspeed=10) instead of the ~268 m motor-road detour.
#
# Run it against the RE-IMPORTED TEST GraphHopper (S1/FEN-1314), which is the only
# graph that contains the pedestrian ways (prod gets them in FEN-1317). GH is
# loopback-only on the NAS, so run this ON the NAS (or via SSH):
#
#   GH_URL=http://127.0.0.1:8989 bash scripts/gh-gourguillon-route-proof.sh
#
# Two checks:
#   [A] PROFILE-ONLY   — plain /route on the deployed bordmap_road profile. This is
#                        the REAL post-deploy proof: it passes once config.yml's
#                        `else_if PEDESTRIAN||FOOTWAY -> 1.0` rule is live.
#   [B] QUERY-SIM      — POST /route with a query-time custom_model that multiplies
#                        the cobblestone `else 0.5` by 2 -> net 1.0. Reproduces the
#                        fix's net effect against the CURRENT (un-redeployed) graph,
#                        so you can prove the fix BEFORE the config redeploy.
#
# PASS: the N->S Gourguillon route distance collapses to the ~50 m direct line
#       (threshold < 120 m) instead of the ~268 m detour.
set -u
GH_URL="${GH_URL:-http://127.0.0.1:8989}"
PROFILE="${PROFILE:-bordmap_road}"
THRESH_M="${THRESH_M:-120}"

# OSM nodes of way 1233389877, lat,lon (Dev Backend snap proof: 0.0-0.1 m).
PA_LAT=45.759319; PA_LON=4.825271   # north
PB_LAT=45.759032; PB_LON=4.824921   # south

echo "GH_URL=$GH_URL profile=$PROFILE threshold=${THRESH_M}m"
echo "Route: Gourguillon N (${PA_LAT},${PA_LON}) -> S (${PB_LAT},${PB_LON})"
echo

parse() { # reads JSON on stdin, prints "dist time npts"
  python3 -c '
import sys,json
try:
    d=json.load(sys.stdin)
except Exception as e:
    print("PARSE_ERR",e); sys.exit(0)
if "paths" in d and d["paths"]:
    p=d["paths"][0]
    print("OK %.1f %.1f %d"%(p["distance"],p["time"]/1000.0,len(p.get("points",{}).get("coordinates",[]))))
else:
    print("GH_ERR", (d.get("message") or json.dumps(d))[:200])
'
}

verdict() { # $1=label $2=parse-output
  set -- "$1" $2
  local label="$1" status="$2" dist="$3"
  if [ "$status" = "OK" ]; then
    awk -v d="$dist" -v t="$THRESH_M" -v l="$label" \
      'BEGIN{printf "[%s] distance=%.1f m -> %s\n", l, d, (d<t?"PASS (takes the Gourguillon)":"FAIL (still detouring)")}'
  else
    echo "[$label] ERROR: $status ${dist:-}"
  fi
}

# [A] profile-only GET
A=$(curl -s -m 10 "$GH_URL/route?point=${PA_LAT},${PA_LON}&point=${PB_LAT},${PB_LON}&profile=${PROFILE}&points_encoded=false" | parse)
verdict "A profile-only" "$A"

# [B] query-time custom_model sim: cobblestone else(0.5) x2 -> net 1.0
BODY='{"profile":"'"$PROFILE"'","points":[['"$PA_LON"','"$PA_LAT"'],['"$PB_LON"','"$PB_LAT"']],"points_encoded":false,"ch.disable":true,"custom_model":{"priority":[{"if":"road_class == PEDESTRIAN || road_class == FOOTWAY","multiply_by":"2"}]}}'
B=$(curl -s -m 10 -H 'Content-Type: application/json' -d "$BODY" "$GH_URL/route" | parse)
verdict "B query-sim x2 (net 1.0)" "$B"

# [C] informational: net 2.0 (x4). If GH 400s here, a literal >1 PROFILE priority
#     would likely boot-kill -> confirms the else_if (<=1) choice.
BODY4='{"profile":"'"$PROFILE"'","points":[['"$PA_LON"','"$PA_LAT"'],['"$PB_LON"','"$PB_LAT"']],"points_encoded":false,"ch.disable":true,"custom_model":{"priority":[{"if":"road_class == PEDESTRIAN || road_class == FOOTWAY","multiply_by":"4"}]}}'
C=$(curl -s -m 10 -H 'Content-Type: application/json' -d "$BODY4" "$GH_URL/route" | parse)
verdict "C query-sim x4 (net 2.0, info)" "$C"
echo
echo "AC-4 is GREEN when [A] (post-redeploy) or [B] (pre-redeploy) reports PASS."
