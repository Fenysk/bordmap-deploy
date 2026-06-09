#!/usr/bin/env bash
# GraphHopper import-or-serve entrypoint for Bordmap R2 (FEN-507).
#
# Responsibilities, in order:
#   1. Ensure the France OSM extract exists on the PERSISTENT volume (/data).
#      Download once from Geofabrik; an atomic .part rename means an interrupted
#      download never leaves a truncated file that would poison the import.
#   2. Hand off to GraphHopper via the official fat-JAR (server command).
#      GraphHopper's "server" command does both the graph import (on first run) and
#      serves HTTP once the import completes. Subsequent restarts skip the import
#      because graph.location (/data/graph-cache) is already populated.
#
# Idempotent + restart-safe: re-running with a populated /data is a no-op import.
set -euo pipefail

DATA_DIR="${GH_DATA_DIR:-/data}"
PBF="${DATA_DIR}/france-latest.osm.pbf"
OSM_URL="${GH_OSM_URL:-https://download.geofabrik.de/europe/france-latest.osm.pbf}"
CONFIG="${GH_CONFIG:-/graphhopper/config.yml}"
GRAPH_CACHE="${DATA_DIR}/graph-cache"
JAR="/graphhopper/graphhopper.jar"

# Heap: MMAP keeps the graph off-heap, so a 2 GB JVM heap is enough for serving.
# The one-time IMPORT is heavier — if it OOM-kills, set GH_JAVA_OPTS=-Xmx4g in
# the Coolify env, let the import finish, then restore -Xmx2g. See README.
JAVA_OPTS="${JAVA_OPTS:--Xmx2g -Xms2g}"

log() { echo "[graphhopper-init] $*" >&2; }

mkdir -p "${DATA_DIR}"

if [ ! -f "${PBF}" ]; then
  log "France OSM extract missing — downloading from ${OSM_URL} (~4.5 GB, one-time)…"
  # -c resumes if a partial .part exists; atomic rename only on full success.
  if command -v wget >/dev/null 2>&1; then
    wget -c -O "${PBF}.part" "${OSM_URL}"
  else
    curl -fL -C - -o "${PBF}.part" "${OSM_URL}"
  fi
  mv "${PBF}.part" "${PBF}"
  log "download complete: $(du -h "${PBF}" | cut -f1)"
else
  log "France OSM extract present ($(du -h "${PBF}" | cut -f1)) — skipping download"
fi

if [ -d "${GRAPH_CACHE}" ] && [ -n "$(ls -A "${GRAPH_CACHE}" 2>/dev/null || true)" ]; then
  log "graph cache present at ${GRAPH_CACHE} — serving (no re-import)"
else
  log "graph cache empty — first import will run (heavy, one-time; see README RAM notes)"
fi

log "launching graphhopper (config=${CONFIG}, heap=${JAVA_OPTS})"
# GraphHopper fat-JAR "server" command: imports graph if graph.location is empty,
# then starts the Dropwizard HTTP server. config.yml sets datareader.file and
# graph.location — no need to pass them as -D flags.
exec java ${JAVA_OPTS} -jar "${JAR}" server "${CONFIG}"
