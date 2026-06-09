# syntax=docker/dockerfile:1
#
# Bordmap — SINGLE IMAGE (CEO directive: "TanStack Start + Convex, le tout dans
# un Docker"). One container runs both the Convex self-host backend AND the
# TanStack Start (Nitro node-server) app, supervised by a tiny entrypoint under
# `tini` (PID 1, signal forwarding, zombie reaping).
#
# R6 (plan §8 of FEN-341): co-hosting backend + app in one image is the risk
# this Dockerfile takes on. The two values that MUST be confirmed on a
# docker-capable host (NAS/CI — they cannot be exercised in the build sandbox)
# are marked `# R6-CHECK` below. If the single image proves fragile, the
# documented fallback is `docker-compose.fallback.yml` (2 services) — switching
# requires board arbitration (do not silently swap).
#
# Build-time arg VITE_CONVEX_URL is baked into the client bundle, so it must be
# the PUBLIC origin the browser uses to reach Convex (e.g. https://bordmap.nas
# behind the reverse proxy, or http://localhost:3210 for plain local runs).

ARG NODE_IMAGE=node:24-bookworm-slim
# Pinned to the convex backend release matching the `convex` npm package we ship
# (1.40.0, published 2026-06-01). The OSS backend publishes per-commit images;
# the ghcr tag is the FULL commit sha of release `precompiled-2026-06-01-aeb5f28`
# (the release cut right after npm 1.40.0). Multi-arch (linux/amd64+arm64),
# verified present on ghcr — good for the Synology NAS. Bump this in lockstep
# with the `convex` npm version. See docs/adr/0001 for the selection rule.
ARG CONVEX_BACKEND_IMAGE=ghcr.io/get-convex/convex-backend:aeb5f28adfe92f88c8c504b7883a12acfdf7cde6

# ---------------------------------------------------------------------------
# Stage 1 — build the Start app (.output = Nitro node-server bundle)
# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS build
ENV PNPM_HOME=/pnpm CI=1
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /app

# Install deps first (cache-friendly).
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
# Pin pnpm to the version that generated pnpm-lock.yaml (lockfileVersion 9.0 →
# pnpm 11.5.0). package.json has NO `packageManager` field, so without this pin
# `corepack enable` would resolve its bundled DEFAULT pnpm — a version mismatch
# that fails `--frozen-lockfile` and ignores the pnpm 10+ `allowBuilds` allowlist
# in pnpm-workspace.yaml (so better-sqlite3 et al. would not build). This is the
# first-real-build fix for the single image (R6); keep it in lockstep with the
# pnpm that maintains the lockfile.
RUN corepack prepare pnpm@11.5.0 --activate
RUN pnpm install --frozen-lockfile

# Copy sources and build. VITE_CONVEX_URL is required at build (client bundle).
COPY . .
ARG VITE_CONVEX_URL
ENV VITE_CONVEX_URL=${VITE_CONVEX_URL}
RUN pnpm run build

# Prune to production deps — we keep `convex` for the runtime `convex deploy`.
RUN pnpm prune --prod

# ---------------------------------------------------------------------------
# Stage 2 — grab the Convex self-host backend binary
# ---------------------------------------------------------------------------
FROM ${CONVEX_BACKEND_IMAGE} AS convex-backend

# ---------------------------------------------------------------------------
# Stage 3 — runtime: node base + convex backend binary + built app
# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS runtime
# openssl: required by the backend's read_credentials.sh to mint the instance
# secret on first boot (node:slim has none). bash: the upstream /convex/*.sh
# scripts are bash. curl: health probe. tini: PID 1 in the entrypoint.
RUN apt-get update \
  && apt-get install -y --no-install-recommends tini ca-certificates curl bash openssl \
  && rm -rf /var/lib/apt/lists/*
RUN corepack enable
ENV NODE_ENV=production
WORKDIR /app

# R6-CHECK (1) — RESOLVED (source-verified against the official backend image
# Dockerfile.backend; live smoke still pending a docker host, see docs/adr/0001):
# the backend toolset lives in /convex and run_backend.sh launches it with
# RELATIVE paths (`./convex-local-backend`, `./generate_key`), sourcing
# `./read_credentials.sh`. Copying ONLY the binary (as L0 did) breaks admin-key
# generation. We mirror the official image's /convex layout and reuse its tested
# launcher rather than reimplementing it — entrypoint.sh just orchestrates.
COPY --from=convex-backend /convex/convex-local-backend /convex/convex-local-backend
COPY --from=convex-backend /convex/generate_key          /convex/generate_key
COPY --from=convex-backend /convex/read_credentials.sh   /convex/read_credentials.sh
COPY --from=convex-backend /convex/run_backend.sh        /convex/run_backend.sh
COPY --from=convex-backend /convex/generate_admin_key.sh /convex/generate_admin_key.sh
RUN chmod +x /convex/convex-local-backend /convex/generate_key /convex/*.sh

# App: built output + convex source/functions + prod node_modules (for the CLI).
COPY --from=build /app/.output ./.output
COPY --from=build /app/convex ./convex
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh || true

# Convex data lives here (SQLite + persisted instance credentials under
# data/credentials); mount a volume in compose. DATA_DIR is the var the upstream
# run_backend.sh reads; CONVEX_DATA_DIR is kept for backward compat.
ENV CONVEX_DATA_DIR=/convex/data
ENV DATA_DIR=/convex/data
RUN mkdir -p /convex/data

# 3000 = Start app (proxied/TLS-terminated by the NAS reverse proxy).
# 3210 = Convex API origin, 3211 = Convex HTTP-actions/site origin.
# R6-CHECK (2) — RESOLVED (source-verified vs upstream run_backend.sh + config.rs):
# run_backend.sh binds `--port 3210 --site-proxy-port 3211` and stores under
# DATA_DIR; these are the backend defaults. Live confirmation pending docker host.
EXPOSE 3000 3210 3211

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["/usr/local/bin/entrypoint.sh"]
