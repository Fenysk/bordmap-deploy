#!/usr/bin/env sh
# Bordmap FALLBACK app-image entrypoint (FEN-444).
#
# The fallback topology (docker-compose.coolify.yml) runs the app and the
# OFFICIAL convex-backend as SEPARATE services, so — unlike the R6 single image —
# nothing pushed schema/functions to the backend: a fresh backend boots EMPTY
# ("Could not find public function for 'routes:list'"). This entrypoint closes
# that gap by deploying the app's convex/ functions to the sibling backend on
# startup, then handing off to the Nitro server.
#
# DESIGN: every pre-server step is BEST-EFFORT. We never `exit` non-zero before
# the final `exec`, so a failed deploy/seed degrades to "backend empty" but NEVER
# takes the (TLS-fronted, no-fallback-domain) app offline. Idempotent by nature:
#   - `convex deploy` re-pushes the same committed functions (no-op if unchanged),
#   - `convex run seed:run` self-guards (skips when the routes table is non-empty).
# So this is safe to run on every container start.
#
# Requires (injected by the compose app service env):
#   CONVEX_SELF_HOSTED_URL        e.g. http://convex-backend:3210
#   CONVEX_SELF_HOSTED_ADMIN_KEY  minted from the backend instance secret
#   AUTH_ISSUER                   ${SITE_URL}/api/auth (Better Auth JWT issuer)
set -u

APP_PORT="${PORT:-3000}"
BACKEND_URL="${CONVEX_SELF_HOSTED_URL:-http://convex-backend:3210}"

# IMPORTANT: log to STDERR. mint_admin_key() is read via `minted=$(mint_admin_key)`,
# which captures stdout — so any diag on stdout would POLLUTE the captured admin
# key. stderr keeps stdout = key-only, and these lines land in the container's
# standard stderr stream.
log() { echo "[app-entrypoint] $*" >&2; }

# Mint the self-host admin key OFFLINE from the instance identity. The official
# /convex/generate_admin_key.sh (copied into the image) derives the SAME stable key
# the backend accepts, given the same INSTANCE_NAME + INSTANCE_SECRET. Echoes the
# key on stdout (never logged here). Returns non-zero if it can't produce one.
mint_admin_key() {
  if [ ! -x /convex/generate_admin_key.sh ]; then
    log "diag: mint skip — /convex/generate_admin_key.sh missing/not-exec"
    return 1
  fi
  seclen=$(printf '%s' "${CONVEX_INSTANCE_SECRET:-}" | wc -c | tr -d ' ')
  log "diag: mint inputs — instance_name=${CONVEX_INSTANCE_NAME:-<unset>} instance_secret_len=${seclen}"
  if [ -z "${CONVEX_INSTANCE_SECRET:-}" ]; then
    log "diag: mint skip — CONVEX_INSTANCE_SECRET empty in app container"
    return 1
  fi
  err=$(mktemp 2>/dev/null || echo /tmp/genkey.err)
  # read_credentials.sh writes to CREDENTIALS_DIR — must be writable even when
  # DATA_DIR is a read-only volume mount. Override to a tmp directory.
  mkdir -p /tmp/convex-cred-cache 2>/dev/null || true
  k=$(cd /convex && DATA_DIR=/convex/data \
        CREDENTIALS_DIR=/tmp/convex-cred-cache \
        INSTANCE_NAME="${CONVEX_INSTANCE_NAME:-bordmap}" \
        INSTANCE_SECRET="${CONVEX_INSTANCE_SECRET}" \
        ./generate_admin_key.sh 2>"${err}" | tail -n1)
  case "${k}" in
    *"|"*) printf '%s' "${k}"; rm -f "${err}" 2>/dev/null; return 0 ;;  # <name>|<hex…>
    *)
      # stderr is safe to surface (errors, not the key); the key only ever hits stdout.
      log "diag: generate_admin_key.sh produced no key — stderr: $(head -c 400 "${err}" 2>/dev/null | tr '\n' ' ')"
      rm -f "${err}" 2>/dev/null
      return 1
      ;;
  esac
}

deploy_convex() {
  # Prefer a freshly-minted key (always correct for this instance) over any
  # externally-set fallback. Mint failures fall back to CONVEX_SELF_HOSTED_ADMIN_KEY.
  if minted=$(mint_admin_key); then
    CONVEX_SELF_HOSTED_ADMIN_KEY="${minted}"
    log "diag: minted admin key offline from instance secret"
  else
    log "diag: offline mint unavailable — using CONVEX_SELF_HOSTED_ADMIN_KEY env fallback"
  fi

  # Diagnostics to stderr (container log stream). NEVER print the admin key value
  # — only its length.
  keylen=0
  [ -n "${CONVEX_SELF_HOSTED_ADMIN_KEY:-}" ] && keylen=$(printf '%s' "${CONVEX_SELF_HOSTED_ADMIN_KEY}" | wc -c | tr -d ' ')
  log "diag: admin_key_len=${keylen} backend=${BACKEND_URL} auth_issuer=${AUTH_ISSUER:-<unset>}"
  log "diag: node=$(node --version 2>/dev/null) convex_present=$( [ -x ./node_modules/.bin/convex ] && echo yes || echo no )"
  log "diag: convex_version=$(npx --no-install convex --version 2>&1 | head -n1)"

  if [ -z "${CONVEX_SELF_HOSTED_ADMIN_KEY:-}" ]; then
    log "WARN: no admin key (mint failed + env fallback empty) — skipping convex deploy (backend stays empty)"
    return 0
  fi

  # Wait (bounded, best-effort) for the sibling backend. compose depends_on
  # already gates on its healthcheck, so this normally returns on the first try.
  i=0
  until curl -fsS "${BACKEND_URL}/version" >/dev/null 2>&1; do
    i=$((i + 1))
    if [ "${i}" -gt 60 ]; then
      log "WARN: convex backend ${BACKEND_URL} not reachable after 60s — skipping deploy"
      return 0
    fi
    sleep 1
  done
  log "convex backend reachable at ${BACKEND_URL}"

  export CONVEX_SELF_HOSTED_URL="${BACKEND_URL}"
  export CONVEX_SELF_HOSTED_ADMIN_KEY

  # Self-hosted Convex stores function env IN the deployment (not process.env), so
  # convex/auth.config.ts reads AUTH_ISSUER from the Convex env store. The Better
  # Auth JWT `iss` is ${SITE_URL}/api/auth, so the provider domain must match or
  # every authed query 401s. Push it BEFORE deploy (best-effort).
  if [ -n "${AUTH_ISSUER:-}" ]; then
    log "convex env set AUTH_ISSUER=${AUTH_ISSUER}"
    npx --no-install convex env set AUTH_ISSUER "${AUTH_ISSUER}" 2>&1 | sed 's/^/[convex env] /' || log "WARN: convex env set AUTH_ISSUER failed (continuing)"
  fi

  # R2 routing (FEN-507): expose the INTERNAL GraphHopper URL to Convex functions.
  # The computeRoutes action (FEN-504) reads it server-side via process.env; like
  # AUTH_ISSUER it lives in the Convex deployment env store, not the container env.
  # Best-effort + guarded → absent var is a no-op (safe before GraphHopper is up).
  if [ -n "${GRAPHHOPPER_URL:-}" ]; then
    log "convex env set GRAPHHOPPER_URL=${GRAPHHOPPER_URL}"
    npx --no-install convex env set GRAPHHOPPER_URL "${GRAPHHOPPER_URL}" 2>&1 | sed 's/^/[convex env] /' || log "WARN: convex env set GRAPHHOPPER_URL failed (continuing)"
  fi

  log "convex deploy (push schema + functions)"
  npx --no-install convex deploy -y 2>&1 | sed 's/^/[convex deploy] /' || log "WARN: convex deploy failed (continuing)"

  # Seed the pilot routes. seed:run is idempotent (skips when routes is non-empty).
  log "convex run seed:run (idempotent pilot seed)"
  npx --no-install convex run seed:run 2>&1 | sed 's/^/[convex seed] /' || log "WARN: convex run seed:run failed (continuing)"
}

# Run the deploy/seed best-effort; a non-zero anywhere must not abort the server.
# log() writes to stderr, so the bootstrap trace lands in the container's standard
# stderr stream. (The former /diag HTTP-served bootstrap/server logs were removed
# in FEN-481 — diagnostic-only, no longer needed now the deploy path is proven.)
deploy_convex || log "WARN: convex bootstrap raised — continuing to server start"

log "starting Start (Nitro) server on :${APP_PORT}"
exec node .output/server/index.mjs
