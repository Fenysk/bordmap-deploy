# Runbook — Bordmap TEST on the shared NAS (FEN-529)

Deploy the **test** build of Bordmap on the Synology NAS, isolated from every
other tenant, mirroring the LivePlace-test pattern (FEN-523).

**Prod is untouched:** `bordmap.fenysk.fr` stays on the Coolify VPS. This runbook
only ever touches the `bordmap-test` Docker project on the NAS.

## Isolation contract

| Concern        | Decision                                                                 |
|----------------|--------------------------------------------------------------------------|
| Docker project | `bordmap-test` → prefixes container, network, and the `convex-data` volume (`bordmap-test_convex-data`). |
| Host ports     | **Loopback-only**, off the 8090/8091 LivePlace block: `8092`→app, `8093`→Convex API, `8094`→Convex site. |
| Exposure       | Tailscale Serve (HTTPS) in front, or `BIND=<tailscale-ip>` for a tailnet HTTP interim. **Never `0.0.0.0`.** |
| Secrets        | `.env` lives **only on the NAS** (`chmod 600`), never in the repo. rsync excludes it. |
| Image          | Same single image as prod (build context = repo root), Convex backend pinned. |

### Why a standalone compose (not a `-f base -f override` overlay)

Bordmap's root `docker-compose.yml` **publishes** `3000/3210/3211` on `0.0.0.0`.
Docker Compose **merges** (appends) port lists across `-f` files — it cannot
remove a base publish — so an overlay would leave those ports open on the LAN and
racing the host on a shared NAS. `deploy/nas/bordmap-test/docker-compose.test.yml`
is therefore self-contained, giving a deterministic loopback-only bind. Its build
context (`../../..`) resolves to the repo root, so the **same image as prod** is
built.

## Prerequisites

- SSH access as `paperclip@nas` (LAN `192.168.1.98`, Tailscale `100.74.250.38`),
  in the `docker` group → no sudo for docker (FEN-522).
- `NAS_SSH_KEY` injected into the agent env (project secret — the issue must carry
  the right `projectId` or the env is starved; the deploy script self-heals a
  flattened-newline PEM either way).
- A filled `.env` on the NAS at `/home/paperclip/deploy/bordmap-test/.env`.

## First-time NAS setup (one-off)

```bash
ssh paperclip@192.168.1.98 'mkdir -p /home/paperclip/deploy/bordmap-test'
# Copy the template, fill secrets, lock it down:
scp deploy/nas/bordmap-test/.env.test.example \
    paperclip@192.168.1.98:/home/paperclip/deploy/bordmap-test/.env
ssh paperclip@192.168.1.98 'chmod 600 /home/paperclip/deploy/bordmap-test/.env'
#   - BETTER_AUTH_SECRET=$(openssl rand -hex 32)
#   - VITE_CONVEX_URL / CONVEX_*_ORIGIN / SITE_URL = the chosen public origins
#     (see the HTTPS vs HTTP-interim blocks in the template)
```

## Deploy / operate

```bash
# Build + start (rsync repo, compose up --build, health-poll, optional TS serve):
NAS_SSH_KEY="$NAS_SSH_KEY" ./scripts/nas-deploy-bordmap.sh up
# Optional HTTPS front (app port):
TS_HOSTNAME=<magicdns>.ts.net NAS_SSH_KEY="$NAS_SSH_KEY" ./scripts/nas-deploy-bordmap.sh up

./scripts/nas-deploy-bordmap.sh smoke   # health checks only
./scripts/nas-deploy-bordmap.sh down    # stop, keep the volume
./scripts/nas-deploy-bordmap.sh nuke    # stop + drop the convex-data volume (DESTRUCTIVE)
```

## Smoke (what "green" means)

1. `curl http://127.0.0.1:8092` → HTTP 200, page mentions **Bordmap**.
2. `curl http://127.0.0.1:8093/version` → Convex backend responds.
3. `convex-data` volume persists across `restart` (stable instance secret).

The repo's `docker/smoke.sh` runs the full 4-point R6 smoke on the NAS host
directly if you want the deeper check.

## Exposure (interim → HTTPS)

- **HTTP interim (no admin):** set `BIND=<tailscale-ip>` in `.env`, then the app
  is at `http://<tailscale-ip>:8092` and Convex at `:8093` / `:8094` over the
  tailnet only. Set the public origins to match.
- **HTTPS (Tailscale Serve):** keep `BIND=127.0.0.1`, run `tailscale serve` to
  front the app, and path-route Convex (`/convex`, `/convex-site`) per the README
  NAS example. Final HTTPS wiring is owned by the **sibling HTTPS issue**.

## Rollback

- `./scripts/nas-deploy-bordmap.sh down` stops the test stack (volume kept).
- The `bordmap-test` project is fully isolated; removing it leaves every other NAS
  tenant and prod `bordmap.fenysk.fr` untouched.
- `nuke` only if you intend to discard the test Convex data.
