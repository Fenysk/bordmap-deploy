#!/usr/bin/env bash
# GraphHopper import-or-serve entrypoint for Bordmap R2 (FEN-507).
#
# Responsibilities, in order:
#   1. Ensure the OSM extract (region per GH_OSM_URL) exists on the volume (/data).
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
# Region-agnostic on-disk filename: config.yml's datareader.file points at this
# STABLE path, so switching GH_OSM_URL to another region never desyncs the config
# or leaves a misnamed extract on the volume (FEN-599). The region is determined
# solely by GH_OSM_URL — wipe the volume on a region switch (README §Region switch).
PBF="${DATA_DIR}/region-latest.osm.pbf"
# DEFAULT = Rhône-Alpes regional extract (FEN-599 — the France extract OOM'd the
# NAS even at 5g; see docker-compose.graphhopper.yml for the cgroup/MMAP rationale).
OSM_URL="${GH_OSM_URL:-https://download.geofabrik.de/europe/france/rhone-alpes-latest.osm.pbf}"
CONFIG="${GH_CONFIG:-/graphhopper/config.yml}"
GRAPH_CACHE="${DATA_DIR}/graph-cache"
JAR="/graphhopper/graphhopper.jar"

# Heap: MMAP keeps the graph off-heap, so a small JVM heap is enough. For the
# regional Rhône-Alpes extract even the one-time import fits in 1g (no temp bump
# needed, unlike the old France import). docker-compose passes JAVA_OPTS; this
# default applies only if the var is unset (e.g. running the image standalone).
JAVA_OPTS="${JAVA_OPTS:--Xmx1g -Xms256m}"

log() { echo "[graphhopper-init] $*" >&2; }

mkdir -p "${DATA_DIR}"

if [ ! -f "${PBF}" ]; then
  log "OSM extract missing — downloading from ${OSM_URL} (one-time; ~430 MB for Rhône-Alpes)…"
  # -c resumes if a partial .part exists; atomic rename only on full success.
  if command -v wget >/dev/null 2>&1; then
    wget -c -O "${PBF}.part" "${OSM_URL}"
  else
    curl -fL -C - -o "${PBF}.part" "${OSM_URL}"
  fi
  mv "${PBF}.part" "${PBF}"
  log "download complete: $(du -h "${PBF}" | cut -f1)"
else
  log "OSM extract present ($(du -h "${PBF}" | cut -f1)) — skipping download"
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
