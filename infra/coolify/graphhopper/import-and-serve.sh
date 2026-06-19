#!/usr/bin/env bash
# GraphHopper entrypoint for Bordmap R2 (FEN-507, FEN-599, FEN-603, FEN-740).
#
# MODEL (FEN-740): the graph cache lives on the PERSISTENT /data Coolify volume
# (config.yml graph.location=/data/graph-cache). On the FIRST deploy the volume is
# empty → this script imports the regional graph ONCE (the runtime container has
# normal egress + RAM, unlike the build-time bake which silently produced an empty
# cache — FEN-603). Every SUBSEQUENT redeploy/recreate finds the graph already on
# the volume and serves immediately with NO re-import (that re-import was the ~10
# min GraphHopper outage window on each deploy — the whole point of FEN-740).
#
# This replaces the FEN-602 build-bake-into-the-image design: the bake never
# produced a usable cache, and even a working bake landed in the writable IMAGE
# layer, which is discarded on recreate — so it re-imported every deploy anyway.
# Importing once onto the volume is the reproducible, recreate-surviving fix.
set -euo pipefail

CONFIG="${GH_CONFIG:-/graphhopper/config.yml}"
# Persistent volume path — MUST match config.yml graph.location and the
# graphhopper-data:/data mount in docker-compose.graphhopper.yml.
GRAPH_CACHE="/data/graph-cache"
JAR="/graphhopper/graphhopper.jar"

# Heap stays small because the graph is MMAP'd from disk (config.yml). Overridable
# via JAVA_OPTS (compose sets it from GH_JAVA_OPTS). 1g is ample for serving a
# regional graph's routing working set (A* priority queues).
JAVA_OPTS="${JAVA_OPTS:--Xmx1g -Xms256m}"

log() { echo "[graphhopper] $*" >&2; }

# One-time import. Triggers when the persistent volume has no graph yet (first
# deploy, or after an intentional volume wipe to switch regions — FEN-599 runbook).
# A capped heap + MMAP (config.yml) keeps the import footprint bounded under the
# 3g mem_limit. Base Rhône-Alpes, no LM — the proven-green workload (FEN-601). Only
# `sleep` (never crash-loop) if the import fails, so a bad state never thrashes the
# host and the failure is diagnosable from the container's stderr/runtime-import.log.
RUNTIME_OSM_URL="${GH_OSM_URL:-https://download.geofabrik.de/europe/france/rhone-alpes-latest.osm.pbf}"
IMPORT_OPTS="${GH_IMPORT_OPTS:--Xmx1500m}"
mkdir -p "$(dirname "${GRAPH_CACHE}")" 2>/dev/null || true
if [ ! -d "${GRAPH_CACHE}" ] || [ -z "$(ls -A "${GRAPH_CACHE}" 2>/dev/null || true)" ]; then
  log "no graph on the persistent volume at ${GRAPH_CACHE} — one-time import."
  log "downloading ${RUNTIME_OSM_URL}"
  rm -rf "${GRAPH_CACHE}" 2>/dev/null || true
  if wget -q -O /graphhopper/osm.pbf "${RUNTIME_OSM_URL}"; then
    log "PBF downloaded ($(du -h /graphhopper/osm.pbf 2>/dev/null | cut -f1)); importing (opts=${IMPORT_OPTS}) …"
    if java ${IMPORT_OPTS} -jar "${JAR}" import "${CONFIG}" 2>&1 | tee /graphhopper/runtime-import.log; then
      rm -f /graphhopper/osm.pbf
      log "import OK → graph built at ${GRAPH_CACHE} ($(du -sh "${GRAPH_CACHE}" 2>/dev/null | cut -f1)) — persisted on the /data volume, no re-import on redeploy."
    else
      log "IMPORT FAILED — staying up (no crash-loop) for diagnosis. Tail:"
      tail -n 25 /graphhopper/runtime-import.log >&2 || true
      exec sleep infinity
    fi
  else
    log "PBF download FAILED from ${RUNTIME_OSM_URL} (egress?) — staying up for diagnosis."
    exec sleep infinity
  fi
else
  log "graph present on the persistent volume at ${GRAPH_CACHE} ($(du -sh "${GRAPH_CACHE}" 2>/dev/null | cut -f1)) — serving without re-import."
fi

log "serving graph from ${GRAPH_CACHE} (config=${CONFIG}, heap=${JAVA_OPTS})"
# GraphHopper fat-JAR "server" command loads the existing graph.location and starts
# the Dropwizard HTTP server. No import (graph already built on the volume).
exec java ${JAVA_OPTS} -jar "${JAR}" server "${CONFIG}"
