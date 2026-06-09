# syntax=docker/dockerfile:1
#
# Bordmap — APP-ONLY image (used by docker-compose.coolify.yml on Coolify and the
# R6 fallback). Builds and runs just the TanStack Start (Nitro node-server); the
# Convex backend runs as a separate service (official image). No backend binary,
# no entrypoint orchestration — the simple, low-risk path that avoids the R6
# single-image co-host risk.

ARG NODE_IMAGE=node:24-bookworm-slim
# Runtime base needs glibc >= 2.38 for the convex generate_key binary (used to
# mint the self-host admin key); bookworm ships 2.36. trixie ships 2.41.
ARG RUNTIME_IMAGE=node:24-trixie-slim
# Pinned official backend image — source of the /convex toolset (generate_admin_key.sh
# + generate_key + convex-local-backend + read_credentials.sh) so the app can MINT the
# self-host admin key from the backend's persisted credentials (FEN-444). Multi-arch.
ARG CONVEX_BACKEND_IMAGE=ghcr.io/get-convex/convex-backend:aeb5f28adfe92f88c8c504b7883a12acfdf7cde6
FROM ${CONVEX_BACKEND_IMAGE} AS convexsrc

FROM ${NODE_IMAGE} AS build
ENV PNPM_HOME=/pnpm CI=1
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
# Pin pnpm to the version that maintains pnpm-lock.yaml (no packageManager field
# -> corepack would otherwise use a mismatched default and fail --frozen-lockfile).
RUN corepack prepare pnpm@11.5.0 --activate
RUN pnpm install --frozen-lockfile
COPY . .
ARG VITE_CONVEX_URL
ENV VITE_CONVEX_URL=${VITE_CONVEX_URL}
RUN pnpm run build && pnpm prune --prod

FROM ${RUNTIME_IMAGE} AS runtime
# curl: container healthcheck. better-sqlite3 (auth.db) ships a prebuilt binary;
# no toolchain needed at runtime since we copy the already-installed node_modules.
RUN apt-get update \
  && apt-get install -y --no-install-recommends tini ca-certificates curl openssl bash \
  && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/.output ./.output
# vite externalises the server-only auth deps (better-sqlite3, kysely,
# @better-auth/*) so they are NOT bundled -> they must be resolvable at runtime
# from node_modules. Copy the pruned prod deps (+ package.json for resolution).
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
# convex deploy (docker/app-entrypoint.sh) bundles the function source on start,
# so the runtime image needs convex/ AND its only cross-dir import
# (app/lib/shared/geo, used by routes.ts + seed.ts). The convex CLI itself ships
# in the pruned prod node_modules (convex is a runtime dependency).
COPY --from=build /app/convex ./convex
COPY --from=build /app/app/lib/shared ./app/lib/shared
COPY --from=build /app/docker/app-entrypoint.sh ./docker/app-entrypoint.sh
RUN chmod +x ./docker/app-entrypoint.sh
# /convex toolset for OFFLINE admin-key minting from persisted credentials. The app
# mounts the backend's convex-data volume (ro) at /convex/data; generate_admin_key.sh
# derives the SAME stable key the backend would (no running backend needed here).
COPY --from=convexsrc /convex/convex-local-backend /convex/convex-local-backend
COPY --from=convexsrc /convex/generate_key          /convex/generate_key
COPY --from=convexsrc /convex/read_credentials.sh   /convex/read_credentials.sh
COPY --from=convexsrc /convex/generate_admin_key.sh /convex/generate_admin_key.sh
RUN chmod +x /convex/convex-local-backend /convex/generate_key /convex/*.sh
# Better Auth SQLite DB (auth.db) lives under DATA_DIR -> mount a volume here.
ENV DATA_DIR=/app/data
RUN mkdir -p /app/data
EXPOSE 3000
ENTRYPOINT ["/usr/bin/tini", "--"]
# Deploy schema+functions+seed to the sibling backend (best-effort), then exec
# the Nitro server. The script ALWAYS starts the server even if deploy fails.
CMD ["/app/docker/app-entrypoint.sh"]
