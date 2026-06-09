#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# nas-deploy-bordmap.sh — bring the Bordmap *TEST* stack up on the shared NAS
# (FEN-529). Same isolation pattern as LivePlace test (FEN-523).
#
# Idempotent: rsync the repo to the NAS, then `docker compose -p bordmap-test`
# up --build with the standalone test compose, health-check, and (optionally)
# front it with Tailscale Serve HTTPS. Prod (bordmap.fenysk.fr on the Coolify
# VPS) is NEVER touched.
#
# Usage:
#   NAS_SSH_KEY="$NAS_SSH_KEY" ./scripts/nas-deploy-bordmap.sh up    # build + start
#   ./scripts/nas-deploy-bordmap.sh down                             # stop (keep vol)
#   ./scripts/nas-deploy-bordmap.sh nuke                             # stop + drop vol
#   ./scripts/nas-deploy-bordmap.sh smoke                            # health checks
#
# Required inputs (env or defaults):
#   NAS_SSH_KEY   — private key for paperclip@NAS. The secret store may flatten
#                   the key's newlines to spaces (FEN-522/523); this script
#                   REBUILDS a valid PEM regardless (self-heal).
#   NAS_HOST      — default 192.168.1.98 (LAN); falls back to Tailscale IP.
#   NAS_USER      — default paperclip
#   NAS_DIR       — default /home/paperclip/deploy/bordmap-test
#   TS_HOSTNAME   — if set, run `tailscale serve` to front the app over HTTPS.
#                   (Convex path-routing for HTTPS is finalized in the sibling
#                    HTTPS issue; this script fronts the app port by default.)
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

CMD="${1:-up}"
NAS_HOST="${NAS_HOST:-192.168.1.98}"
NAS_HOST_FALLBACK="${NAS_HOST_FALLBACK:-100.74.250.38}"  # Tailscale IP (FEN-522)
NAS_USER="${NAS_USER:-paperclip}"
NAS_DIR="${NAS_DIR:-/home/paperclip/deploy/bordmap-test}"
PROJECT="bordmap-test"
APP_PORT="${APP_PORT:-8092}"
CONVEX_API_PORT="${CONVEX_API_PORT:-8093}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

log() { printf '\033[1;36m[nas-bordmap]\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m[nas-bordmap] ERROR:\033[0m %s\n' "$*" >&2; exit 1; }

# ── 1. Reconstruct a valid PEM from NAS_SSH_KEY (self-heal flattened newlines) ──
prepare_key() {
  [ -n "${NAS_SSH_KEY:-}" ] || die "NAS_SSH_KEY is not set. This script needs the \
paperclip@NAS private key injected to reach the NAS (project secret — ensure the \
issue carries the right projectId so the env is populated)."
  KEYFILE="$(mktemp)"; chmod 600 "$KEYFILE"
  trap 'rm -f "$KEYFILE"' EXIT
  # Always run through python3 normalizer — handles all variations:
  # pure single-line (spaces), mixed (some \n + some spaces), pure multi-line.
  # Simply stripping all whitespace from the base64 body and re-wrapping is
  # safe for any PEM regardless of the original line-break style.
  python3 - "$KEYFILE" <<'PY'
import os, re, sys
raw = os.environ["NAS_SSH_KEY"].strip()
m = re.match(r"(-----BEGIN [A-Z0-9 ]+-----)\s+(.*?)\s+(-----END [A-Z0-9 ]+-----)\s*$", raw, re.S)
if not m:
    sys.exit("NAS_SSH_KEY does not look like a PEM (no BEGIN/END markers)")
header, body, footer = m.group(1), m.group(2), m.group(3)
body = re.sub(r"\s+", "", body)
wrapped = "\n".join(body[i:i+64] for i in range(0, len(body), 64))
open(sys.argv[1], "w").write(f"{header}\n{wrapped}\n{footer}\n")
PY
  ssh-keygen -y -f "$KEYFILE" >/dev/null 2>&1 || die "Reconstructed key is invalid PEM"
  log "PEM reconstructed and validated."
}

ssh_nas() { ssh -i "$KEYFILE" -o BatchMode=yes -o StrictHostKeyChecking=accept-new \
  -o ConnectTimeout=8 "${NAS_USER}@${ACTIVE_HOST}" "$@"; }

pick_host() {
  for h in "$NAS_HOST" "$NAS_HOST_FALLBACK"; do
    if timeout 6 bash -c "cat < /dev/null > /dev/tcp/$h/22" 2>/dev/null; then
      ACTIVE_HOST="$h"; log "NAS reachable on $h:22"; return 0
    fi
  done
  die "NAS unreachable on $NAS_HOST and $NAS_HOST_FALLBACK (port 22)."
}

COMPOSE=(docker compose -p "$PROJECT" \
  -f deploy/nas/bordmap-test/docker-compose.test.yml \
  --env-file .env)

sync_repo() {
  ssh_nas "mkdir -p '$NAS_DIR'"
  log "rsync repo -> ${NAS_USER}@${ACTIVE_HOST}:${NAS_DIR}"
  rsync -az --delete \
    --exclude '.git' --exclude 'node_modules' --exclude 'dist' \
    --exclude '.env' --exclude '*.local' \
    -e "ssh -i '$KEYFILE' -o BatchMode=yes -o StrictHostKeyChecking=accept-new" \
    "$REPO_ROOT/" "${NAS_USER}@${ACTIVE_HOST}:${NAS_DIR}/"
  # The stack .env is provisioned out-of-band on the NAS (secrets, never in repo).
  ssh_nas "test -f '$NAS_DIR/.env'" \
    || die "No $NAS_DIR/.env on the NAS. Copy deploy/nas/bordmap-test/.env.test.example -> .env (chmod 600), fill secrets."
}

remote_compose() { ssh_nas "cd '$NAS_DIR' && ${COMPOSE[*]} $*"; }

smoke() {
  log "Pre-flight: arch / free ports / disk / tenants"
  ssh_nas "uname -m; echo '--- ports ---'; ss -ltn | grep -E ':(8090|8091|8092|8093|8094)\b' || true; \
           echo '--- disk ---'; df -h '$NAS_DIR' | tail -1; \
           echo '--- containers ---'; docker ps --format '{{.Names}}\t{{.Status}}' | grep -i bordmap || true"
  log "Health 1/2: app on 127.0.0.1:${APP_PORT}"
  ssh_nas "code=\$(curl -s -o /tmp/bordmap.html -w '%{http_code}' -m 6 http://127.0.0.1:${APP_PORT}); \
           [ \"\$code\" = 200 ] && grep -qi bordmap /tmp/bordmap.html && echo ' OK app 200 + Bordmap page'" \
    || log "WARN app not green yet on :${APP_PORT}"
  log "Health 2/2: Convex backend /version on 127.0.0.1:${CONVEX_API_PORT}"
  ssh_nas "curl -fsS -m 6 http://127.0.0.1:${CONVEX_API_PORT}/version && echo ' OK /version'" \
    || log "WARN convex /version not green yet on :${CONVEX_API_PORT}"
}

case "$CMD" in
  up)
    prepare_key; pick_host; sync_repo
    log "docker compose up -d --build (project=$PROJECT)"
    remote_compose up -d --build
    log "Waiting for app health…"
    for i in $(seq 1 30); do
      if ssh_nas "curl -fsS -m 4 http://127.0.0.1:${APP_PORT}" >/dev/null 2>&1; then
        log "app healthy."; break
      fi; sleep 6
      [ "$i" = 30 ] && log "WARN app still not healthy after 180s — inspect logs."
    done
    if [ -n "${TS_HOSTNAME:-}" ]; then
      log "tailscale serve HTTPS -> 127.0.0.1:${APP_PORT}"
      ssh_nas "tailscale serve --bg --https=443 http://127.0.0.1:${APP_PORT}" \
        || log "WARN tailscale serve failed (run manually with sudo if needed)."
    fi
    smoke
    log "Done. Preview: https://${TS_HOSTNAME:-<set TS_HOSTNAME>}/  (or http://<tailscale-ip>:${APP_PORT})"
    ;;
  down) prepare_key; pick_host; remote_compose down ;;
  nuke) prepare_key; pick_host; remote_compose down -v ;;
  smoke) prepare_key; pick_host; smoke ;;
  *) die "unknown command: $CMD (use up|down|nuke|smoke)" ;;
esac
