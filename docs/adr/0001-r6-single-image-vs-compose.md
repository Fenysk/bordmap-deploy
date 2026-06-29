# ADR 0001 — R6: Convex + Start co-hosting (single image vs compose)

- **Status:** Accepted — **single image VALIDATED live on the NAS (FEN-353, 2026-06-16):** build + run + 4-point smoke all green after fixing two defects only a live run surfaced (glibc base, runtime `app/lib` for `convex deploy`). Fallback remains the documented escape hatch.
- **Date:** 2026-06-07 (validated 2026-06-16)
- **Context refs:** FEN-345 (L0), FEN-353 (R6 validation), FEN-522 (NAS SSH+Docker access), plan §1/§8 of FEN-341, CEO directive `7b1f9451`

## Live validation result (FEN-353, NAS `nas-hermes`, Docker 29.5.1)

`docker compose up --build` of the single image, isolated project, smoke = 4/4 PASS:
backend `/version` responds · `convex deploy` pushes functions (idempotent across
restart) · app `:3000` → HTTP 200 + Bordmap page · `convex-data` volume persists
(instance secret stable across restart). Two single-image defects found & fixed:

1. **glibc mismatch (boot-blocking).** The `convex-local-backend` binary requires
   `GLIBC_2.38/2.39`; `node:24-bookworm-slim` (Debian 12) ships 2.36 → backend
   never boots (`version 'GLIBC_2.38' not found`). **Fix:** runtime/build base →
   `node:24-trixie-slim` (Debian 13, glibc 2.41). The fallback was immune because
   it runs the official image unmodified.
2. **`convex deploy` can't resolve `../app/lib/shared/*`.** Convex functions
   (`routing.ts`, `routes.ts`, `seed.ts`) import the shared geo/route lib; the
   runtime image copied `convex/` + `.output/` but not the `app/` source. **Fix:**
   `COPY --from=build /app/app/lib ./app/lib`.
3. **Runtime config (not a defect):** `auth.config.ts` requires `AUTH_ISSUER` in the
   Convex env; the entrypoint sets it via `convex env set` when provided. Must be
   passed at deploy time (else `convex deploy` 400s on the auth config eval).

## Context

The CEO directive locks the packaging: *"TanStack Start + Convex, le tout dans
un Docker."* Plan risk **R6** flags that co-hosting the Convex self-host backend
and the Start (Nitro) server in **one image** is the packaging risk of L0, and
pre-authorises a **documented fallback** of a 2-service `docker-compose` if the
single image proves fragile — *to be arbitrated with the board before switching.*

The L0 build sandbox has **no Docker daemon**, so `docker build` / `docker
compose up` cannot be exercised here. The application itself is fully verified
without Docker (install, lint, typecheck, test, prod build, prod server boot).

## Decision

1. **Target = single image** (`Dockerfile` + `docker/entrypoint.sh` +
   `docker-compose.yml`). One container runs the Convex backend and the Start
   server, supervised by `tini`; the entrypoint starts the backend, waits for
   health, pushes functions (`convex deploy`), then runs the node server.
2. **Fallback = 2 services**, fully written and ready
   (`docker-compose.fallback.yml` + `Dockerfile.app`): the OSS backend image
   unmodified + an app-only image. This is the low-risk reference and is the
   path to flip to **only with board arbitration**.
3. **CI** validates the required gate (lint + typecheck + build + tests) on
   every push, plus a Docker build smoke of the app-only image. The single
   image build is the explicit R6 validation to run on the NAS or a Docker
   runner with `CONVEX_BACKEND_IMAGE` pinned.

## R6-CHECK — source-verified (FEN-353), live smoke still pending a docker host

Verified against the official backend image source at the pinned commit
(`Dockerfile.backend`, `run_backend.sh`, `read_credentials.sh`,
`generate_admin_key.sh`, `crates/local_backend/src/config.rs`):

1. **Binary path** = `/convex/convex-local-backend` ✓. But the image also ships
   `generate_key`, `read_credentials.sh`, `run_backend.sh`, `generate_admin_key.sh`
   in `/convex`, launched with **relative paths**. **L0 defect found:** the single
   image copied only the binary + `generate_admin_key.sh`, so admin-key generation
   (`source ./read_credentials.sh`, `./generate_key`) would have failed → no
   `convex deploy` → empty schema. **Fixed:** the Dockerfile now mirrors the full
   `/convex` toolset and `entrypoint.sh` reuses the upstream `run_backend.sh`
   launcher instead of reimplementing it. Added `openssl`/`bash` to the runtime
   (needed by `read_credentials.sh`).
2. **Ports / flags** = `--port 3210`, `--site-proxy-port 3211`, `--local-storage`
   ✓ (confirmed in `run_backend.sh` + `config.rs`).
3. **`convex deploy`** now uses a **stable** admin key: `read_credentials.sh`
   persists the instance secret under `${DATA_DIR}/credentials` (on the volume),
   so the derived key survives restarts.

**Image pin:** `CONVEX_BACKEND_IMAGE` = full sha of release
`precompiled-2026-06-01-aeb5f28` (cut right after `convex` npm 1.40.0, published
2026-06-01; multi-arch amd64+arm64, verified on ghcr). Selection rule recorded in
`.env.example`.

**Still required (cannot run in the build sandbox — no docker daemon):** execute
`docker/smoke.sh` on a docker host (NAS or a CI runner with a docker daemon) to
confirm build+run+smoke live, then wire the NAS reverse proxy + TLS to `:3000`.
This is the open item tracked by FEN-353; it needs board-provided host access.

## Consequences

- Devs are unblocked immediately: the app runs locally with `pnpm dev` + a
  self-host backend, no Docker required.
- If R6-CHECK fails on the NAS, switch the default to
  `docker-compose.fallback.yml` (board arbitration) — no app code changes
  needed, only the compose entrypoint.
- Pin both `convex` (npm) and `CONVEX_BACKEND_IMAGE` to matching versions before
  the first NAS deploy.
