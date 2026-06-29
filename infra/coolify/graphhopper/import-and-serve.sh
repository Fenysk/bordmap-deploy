#!/usr/bin/env bash
# GraphHopper IMPORT-ONCE-THEN-SERVE entrypoint for Bordmap R2 (FEN-507, FEN-599,
# FEN-602, FEN-603, FEN-740).
#
# FEN-740: the graph cache lives on the PERSISTENT /data volume (graphhopper-data,
# mounted in docker-compose.coolify.yml; config.yml pins graph.location there). The
# flow is:
#   - First boot of a fresh volume: /data/graph-cache is empty → IMPORT once
#     (download the regional PBF, `java … import`, ~10 min), then SERVE.
#   - Every boot thereafter: the volume already holds the graph → SERVE immediately,
#     NO import. The volume survives container recreate (redeploy), so a redeploy no
#     longer re-imports — that ~10 min GH outage used to recur on every recreate.
#
# This supersedes the FEN-602 build-time bake (Dockerfile `import`), which silently
# produced an EMPTY graph-cache (OOM / Geofabrik egress on the Coolify builder;
# undiagnosable without a prod VPS shell — FEN-739) AND landed in the throwaway image
# layer anyway. The import runs HERE because the runtime container has normal egress
# and RAM, with a capped heap (MMAP keeps the rest off-heap). Base Rhône-Alpes, no LM
# — the proven-green workload (FEN-601). If the one-time import fails we `sleep`
# (no crash-loop) so a bad state never thrashes the host.
set -euo pipefail

CONFIG="${GH_CONFIG:-/graphhopper/config.yml}"
GRAPH_CACHE="/data/graph-cache"
JAR="/graphhopper/graphhopper.jar"

# Serve heap stays small because the graph is MMAP'd from disk (config.yml).
# Overridable via JAVA_OPTS (compose sets it from GH_JAVA_OPTS).
JAVA_OPTS="${JAVA_OPTS:--Xmx1g -Xms256m}"
# One-time import heap — capped; MMAP keeps the graph off-heap (config.yml).
RUNTIME_OSM_URL="${GH_OSM_URL:-https://download.geofabrik.de/europe/france/rhone-alpes-latest.osm.pbf}"
IMPORT_OPTS="${GH_IMPORT_OPTS:--Xmx1500m}"

log() { echo "[graphhopper] $*" >&2; }

# /data is the mounted volume; ensure it exists (it does, but be defensive).
mkdir -p /data 2>/dev/null || true

if [ ! -d "${GRAPH_CACHE}" ] || [ -z "$(ls -A "${GRAPH_CACHE}" 2>/dev/null || true)" ]; then
  log "no persisted graph at ${GRAPH_CACHE} (fresh volume) — running ONE-TIME import."
  log "downloading ${RUNTIME_OSM_URL}"
  rm -rf "${GRAPH_CACHE}" 2>/dev/null || true
  if wget -q -O /graphhopper/osm.pbf "${RUNTIME_OSM_URL}"; then
    log "PBF downloaded ($(du -h /graphhopper/osm.pbf 2>/dev/null | cut -f1)); importing (opts=${IMPORT_OPTS}) …"
    if java ${IMPORT_OPTS} -jar "${JAR}" import "${CONFIG}" 2>&1 | tee /data/import.log; then
      rm -f /graphhopper/osm.pbf
      log "import OK → graph persisted at ${GRAPH_CACHE} ($(du -sh "${GRAPH_CACHE}" 2>/dev/null | cut -f1)); future boots serve it directly."
    else
      log "IMPORT FAILED — staying up (no crash-loop) for diagnosis. Tail:"
      tail -n 25 /data/import.log >&2 || true
      exec sleep infinity
    fi
  else
    log "PBF download FAILED from ${RUNTIME_OSM_URL} (egress?) — staying up for diagnosis."
    exec sleep infinity
  fi
else
  log "persisted graph found at ${GRAPH_CACHE} — serving directly (no import)."
fi

log "serving graph from ${GRAPH_CACHE} (config=${CONFIG}, heap=${JAVA_OPTS})"
# GraphHopper fat-JAR "server" command loads the existing graph.location and starts
# the Dropwizard HTTP server. No import (graph already built/persisted).
exec java ${JAVA_OPTS} -jar "${JAR}" server "${CONFIG}"
