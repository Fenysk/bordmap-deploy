#!/usr/bin/env sh
# Bordmap single-image entrypoint (R6).
#
# Orchestrates, in order, inside ONE container:
#   1. start the Convex self-host backend (background),
#   2. wait for it to be healthy,
#   3. push schema + functions to it (`convex deploy`, idempotent),
#   4. start the TanStack Start (Nitro) node server in the foreground.
#
# We deliberately DO NOT reimplement the backend launch. The official backend
# image ships /convex/run_backend.sh (+ generate_key, read_credentials.sh,
# generate_admin_key.sh); we mirror that /convex layout in the Dockerfile and
# reuse run_backend.sh so port/origin/storage flags and — crucially — instance
# identity persistence (DATA_DIR/credentials) stay byte-for-byte upstream.
# read_credentials.sh persists instance_name/instance_secret under
# ${DATA_DIR}/credentials, so generate_admin_key.sh yields a STABLE admin key
# across restarts (same data volume => same key) with no config needed.
#
# `tini` is PID 1 (see Dockerfile ENTRYPOINT). We trap signals to stop the
# backend when the server exits so the container shuts down cleanly.
set -eu

BACKEND_DIR=/convex
APP_DIR=/app
CONVEX_PORT="${CONVEX_PORT:-3210}"
CONVEX_SITE_PORT="${CONVEX_SITE_PORT:-3211}"
APP_PORT="${PORT:-3000}"

# DATA_DIR is what run_backend.sh / read_credentials.sh read. Default matches
# the Dockerfile volume. In prod set CONVEX_CLOUD_ORIGIN / CONVEX_SITE_ORIGIN to
# the PUBLIC origins the browser uses (behind the NAS reverse proxy); locally
# the loopback defaults are fine.
export DATA_DIR="${DATA_DIR:-${CONVEX_DATA_DIR:-/convex/data}}"
export CONVEX_CLOUD_ORIGIN="${CONVEX_CLOUD_ORIGIN:-http://127.0.0.1:${CONVEX_PORT}}"
export CONVEX_SITE_ORIGIN="${CONVEX_SITE_ORIGIN:-http://127.0.0.1:${CONVEX_SITE_PORT}}"
# Self-host: no telemetry by default.
export DISABLE_BEACON="${DISABLE_BEACON:-true}"

log() { echo "[entrypoint] $*"; }

# 1. Start the Convex backend via the upstream launcher (background).
log "starting convex self-host backend (upstream run_backend.sh) on :${CONVEX_PORT} (site :${CONVEX_SITE_PORT})"
( cd "${BACKEND_DIR}" && exec ./run_backend.sh ) >/proc/1/fd/1 2>/proc/1/fd/2 &
BACKEND_PID=$!

cleanup() {
  log "shutting down (backend pid ${BACKEND_PID})"
  kill "${BACKEND_PID}" 2>/dev/null || true
}
trap cleanup INT TERM EXIT

# 2. Wait for backend health.
log "waiting for convex backend…"
i=0
until curl -fsS "${CONVEX_CLOUD_ORIGIN}/version" >/dev/null 2>&1; do
  i=$((i + 1))
  if [ "${i}" -gt 90 ]; then
    log "ERROR: convex backend did not become healthy in time"
    exit 1
  fi
  sleep 1
done
log "convex backend is up"

# 3. Obtain an admin key, then push schema + functions (idempotent).
#    A stable key can be injected via CONVEX_SELF_HOSTED_ADMIN_KEY (Docker
#    secret); otherwise we derive it from the persisted instance credentials —
#    which is itself stable across restarts on the same volume.
if [ -z "${CONVEX_SELF_HOSTED_ADMIN_KEY:-}" ]; then
  log "deriving self-host admin key from persisted instance credentials"
  CONVEX_SELF_HOSTED_ADMIN_KEY="$(cd "${BACKEND_DIR}" && ./generate_admin_key.sh 2>/dev/null | tail -n1 || true)"
fi
export CONVEX_SELF_HOSTED_URL="${CONVEX_CLOUD_ORIGIN}"
export CONVEX_SELF_HOSTED_ADMIN_KEY

cd "${APP_DIR}"
if [ -n "${CONVEX_SELF_HOSTED_ADMIN_KEY:-}" ]; then
  if [ -n "${GRAPHHOPPER_URL:-}" ]; then
    log "setting Convex env GRAPHHOPPER_URL=${GRAPHHOPPER_URL}"
    npx convex env set GRAPHHOPPER_URL "${GRAPHHOPPER_URL}" >/proc/1/fd/1 2>/proc/1/fd/2 || log "WARN: convex env set GRAPHHOPPER_URL failed (continuing)"
  fi
  log "deploying convex functions"
  npx convex deploy -y >/proc/1/fd/1 2>/proc/1/fd/2 || log "WARN: convex deploy failed (continuing)"
else
  log "WARN: no admin key — skipping convex deploy (set CONVEX_SELF_HOSTED_ADMIN_KEY)"
fi

# 4. Start the app server in the foreground.
log "starting Start (Nitro) server on :${APP_PORT}"
PORT="${APP_PORT}" exec node .output/server/index.mjs
