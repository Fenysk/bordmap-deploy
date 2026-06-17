#!/usr/bin/env bash
# Bordmap R6 smoke — single-image build + run + smoke, on ANY docker host
# (NAS or CI runner). This is the reproducible validation the build sandbox
# cannot run (no docker daemon). Run from the repo root:
#
#   ./docker/smoke.sh
#
# Env knobs:
#   VITE_CONVEX_URL   public Convex origin baked into the client (default loopback)
#   COMPOSE_FILE      docker-compose.yml (default, single image) | docker-compose.fallback.yml
#   KEEP_UP=1         don't tear down at the end (for manual inspection)
#
# Exit non-zero on the first failed check. Validates the four R6 smoke points:
#   1. backend /version responds
#   2. convex deploy pushed the schema (entrypoint log)
#   3. app serves on :3000 (HTTP 200, Bordmap page)
#   4. convex-data volume persists across a restart (same admin key / data dir)
set -euo pipefail

COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.yml}"
export VITE_CONVEX_URL="${VITE_CONVEX_URL:-http://localhost:3210}"
COMPOSE=(docker compose -f "$COMPOSE_FILE")

log() { echo "[smoke] $*"; }
fail() { echo "[smoke] FAIL: $*" >&2; exit 1; }

cleanup() {
  if [ "${KEEP_UP:-0}" != "1" ]; then
    log "tearing down"
    "${COMPOSE[@]}" down -v >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

wait_for() { # url, label, tries
  local url="$1" label="$2" tries="${3:-90}" i=0
  log "waiting for $label ($url)…"
  until curl -fsS "$url" >/dev/null 2>&1; do
    i=$((i + 1)); [ "$i" -gt "$tries" ] && fail "$label not reachable after ${tries}s"
    sleep 1
  done
  log "$label is up"
}

log "building + starting ($COMPOSE_FILE), VITE_CONVEX_URL=$VITE_CONVEX_URL"
"${COMPOSE[@]}" up --build -d

# 1. backend /version
wait_for "http://localhost:3210/version" "convex backend" 120
log "1/4 OK — backend /version responds: $(curl -fsS http://localhost:3210/version)"

# 3. app on :3000 (do this before grepping logs so the server has booted)
wait_for "http://localhost:3000" "app" 120
code="$(curl -s -o /tmp/bordmap-smoke.html -w '%{http_code}' http://localhost:3000)"
[ "$code" = "200" ] || fail "app returned HTTP $code (expected 200)"
grep -qi "bordmap" /tmp/bordmap-smoke.html || fail "app page does not mention Bordmap"
log "3/4 OK — app serves HTTP 200 and renders the Bordmap page"

# 2. convex deploy pushed the schema (single-image entrypoint logs it; the
#    fallback runs deploy on the app service the same way).
if "${COMPOSE[@]}" logs 2>&1 | grep -qiE "deploying convex functions|Convex functions ready|deployed"; then
  log "2/4 OK — convex deploy ran (schema pushed)"
else
  "${COMPOSE[@]}" logs 2>&1 | grep -i convex | tail -20 || true
  fail "no evidence convex deploy pushed the schema"
fi

# 4. volume persists across restart — capture the persisted instance secret,
#    restart, confirm it is unchanged (=> stable admin key).
svc="$("${COMPOSE[@]}" ps --services | head -1)"
before="$("${COMPOSE[@]}" exec -T "$svc" cat /convex/data/credentials/instance_secret 2>/dev/null || true)"
[ -n "$before" ] || log "note: instance_secret not found (may differ in fallback layout) — checking data dir persistence instead"
log "restarting to test persistence…"
"${COMPOSE[@]}" restart >/dev/null
wait_for "http://localhost:3210/version" "convex backend (after restart)" 120
after="$("${COMPOSE[@]}" exec -T "$svc" cat /convex/data/credentials/instance_secret 2>/dev/null || true)"
if [ -n "$before" ]; then
  [ "$before" = "$after" ] || fail "instance secret changed across restart — volume not persisting"
  log "4/4 OK — convex-data volume persists (stable instance secret across restart)"
else
  [ -n "$after" ] || fail "data dir empty after restart — volume not persisting"
  log "4/4 OK — convex-data volume persists across restart"
fi

log "ALL CHECKS PASSED ($COMPOSE_FILE)"
