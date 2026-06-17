#!/usr/bin/env bash
# GraphHopper SERVE-ONLY entrypoint for Bordmap R2 (FEN-507, FEN-599, FEN-602).
#
# FEN-602 (ADR 0002 Amendment 1): the graph cache is BAKED INTO THE IMAGE at build
# time (see Dockerfile: wget PBF + `java … import config.yml`). The runtime container
# normally only SERVES the pre-built graph. FEN-603: a runtime import FALLBACK was
# added below — it triggers ONLY when the baked graph is missing/empty (a silently
# failed build bake), so the happy path is still serve-only with no cold-import RAM
# spike; the fallback is the recovery path that keeps :8989 from going dark.
#
# config.yml pins graph.location to /graphhopper/graph-cache (an IMAGE path, NOT
# the /data volume), so nothing here touches /data and no volume can shadow the
# baked graph.
set -euo pipefail

CONFIG="${GH_CONFIG:-/graphhopper/config.yml}"
GRAPH_CACHE="/graphhopper/graph-cache"
JAR="/graphhopper/graphhopper.jar"

# Heap stays small because the graph is MMAP'd from disk (config.yml). Overridable
# via JAVA_OPTS (compose sets it from GH_JAVA_OPTS). 1g is ample for serving a
# regional graph's routing working set (A*/LM priority queues).
JAVA_OPTS="${JAVA_OPTS:--Xmx1g -Xms256m}"

log() { echo "[graphhopper-serve] $*" >&2; }

# FEN-601 diagnostic: surface the build-time bake log via the shared `diag` volume
# (mounted at /diag-out) so it is readable at https://<host>/diag/gh-bake.log —
# Coolify does not expose build logs over its API. Best-effort; never blocks serve.
if [ -f /graphhopper/bake.log ]; then
  mkdir -p /diag-out 2>/dev/null || true
  cp -f /graphhopper/bake.log /diag-out/gh-bake.log 2>/dev/null || true
  log "copied bake.log → /diag-out/gh-bake.log (served at /diag/gh-bake.log)"
fi

# FEN-603 (DevOps, 2026-06-17): SELF-HEALING runtime import fallback.
# Root cause of the week-long GraphHopper outage: the build-time bake (Dockerfile
# `import`) has been SILENTLY producing an empty graph-cache — the Dockerfile wraps
# the import so the build ALWAYS succeeds even when the import fails (OOM or a
# Geofabrik egress failure on the Coolify builder). With an empty cache this entry
# point used to `exec sleep infinity`, so the container stayed "running" but NOTHING
# listened on :8989 (board: "graphhopper:8989 connection refused", stack
# running:unhealthy, restart_count 0 — i.e. asleep, not crash-looping). The Coolify
# API exposes only the proxy's logs and there is no VPS shell, so the bake log was
# unreadable. Rather than sleep forever, RECOVER: if the baked graph is missing, run
# the import HERE (the runtime container has normal egress + RAM, unlike the builder)
# with a capped heap (MMAP keeps the rest off-heap), then serve. Base Rhône-Alpes,
# no LM — the proven-green workload (FEN-601). Only `sleep` (not crash-loop) if the
# runtime import ALSO fails, so a bad state never thrashes the host.
RUNTIME_OSM_URL="${GH_OSM_URL:-https://download.geofabrik.de/europe/france/rhone-alpes-latest.osm.pbf}"
IMPORT_OPTS="${GH_IMPORT_OPTS:--Xmx1500m}"
if [ ! -d "${GRAPH_CACHE}" ] || [ -z "$(ls -A "${GRAPH_CACHE}" 2>/dev/null || true)" ]; then
  log "baked graph cache missing/empty at ${GRAPH_CACHE} — build bake did not produce a graph."
  log "RUNTIME IMPORT fallback: downloading ${RUNTIME_OSM_URL}"
  rm -rf "${GRAPH_CACHE}" 2>/dev/null || true
  if wget -q -O /graphhopper/osm.pbf "${RUNTIME_OSM_URL}"; then
    log "PBF downloaded ($(du -h /graphhopper/osm.pbf 2>/dev/null | cut -f1)); importing (opts=${IMPORT_OPTS}) …"
    if java ${IMPORT_OPTS} -jar "${JAR}" import "${CONFIG}" 2>&1 | tee /graphhopper/runtime-import.log; then
      rm -f /graphhopper/osm.pbf
      log "runtime import OK → graph built at ${GRAPH_CACHE} ($(du -sh "${GRAPH_CACHE}" 2>/dev/null | cut -f1))"
    else
      log "RUNTIME IMPORT FAILED — staying up (no crash-loop) for diagnosis. Tail:"
      tail -n 25 /graphhopper/runtime-import.log >&2 || true
      exec sleep infinity
    fi
  else
    log "PBF download FAILED from ${RUNTIME_OSM_URL} (egress?) — staying up for diagnosis."
    exec sleep infinity
  fi
fi

log "serving pre-baked graph from ${GRAPH_CACHE} (config=${CONFIG}, heap=${JAVA_OPTS})"
# GraphHopper fat-JAR "server" command loads the existing graph.location and starts
# the Dropwizard HTTP server. No import (graph already built at image build).
exec java ${JAVA_OPTS} -jar "${JAR}" server "${CONFIG}"
