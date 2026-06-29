# syntax=docker/dockerfile:1
# Bordmap R2 GraphHopper routing service (FEN-507).
#
# GraphHopper has no official Docker image — we build from the official release JAR
# (https://github.com/graphhopper/graphhopper/releases). Pinned to 8.0:
#   - v8 supports vehicle:roads + inline custom_model in config (see config.yml).
#   - v9 dropped vehicle: and restructured profiles; bumping requires migrating config.
#
# config.yml + import-and-serve.sh are BAKED IN (never bind-mounted): Coolify's
# single-file bind-mount hits the OCI mount bug (same reason the app's Caddyfile is
# baked). All MUTABLE data (graph cache, SRTM cache) lives on the PERSISTENT runtime
# VOLUME mounted at /data (graphhopper-data). FEN-740: the graph is IMPORTED ONCE at
# runtime onto that volume (see import-and-serve.sh) — NOT baked at build. The old
# FEN-602 build bake silently produced an empty cache (OOM/egress on the Coolify
# builder, undiagnosable without a prod VPS shell — FEN-739) and was thrown away on
# recreate anyway, so it was removed.
#
# Multi-arch: eclipse-temurin:11-jre ships both amd64 and arm64 layers, covering
# the NAS (arm64) and x86_64 CI/staging.
FROM eclipse-temurin:11-jre-jammy

ARG GH_VERSION=8.0

# wget for the one-time Geofabrik download; curl for the container healthcheck.
RUN apt-get update \
  && apt-get install -y --no-install-recommends wget curl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /graphhopper

# Download the official GraphHopper fat-JAR from GitHub releases.
# The 8.0 release ships a SINGLE runnable uber-jar named `graphhopper-web-8.0.jar`
# (~45 MB, deps shaded in). The `-with-dep` suffix is a Maven-local artifact name,
# NOT the GitHub release asset — using it 404s and fails the build (FEN-507).
RUN wget -q --show-progress \
      "https://github.com/graphhopper/graphhopper/releases/download/${GH_VERSION}/graphhopper-web-${GH_VERSION}.jar" \
      -O graphhopper.jar \
  && echo "GraphHopper ${GH_VERSION} JAR downloaded: $(du -h graphhopper.jar | cut -f1)"

# Build context is THIS directory (infra/coolify/graphhopper — set in the compose
# `build.context`), so config.yml + import-and-serve.sh are COPY'd by their local
# names. Do NOT use repo-root-relative paths with a `../../..` context: Coolify's
# dockercompose build pack rejects COPY paths that escape the resolved context,
# which silently failed the build right after the JAR step (FEN-507).
COPY config.yml /graphhopper/config.yml
COPY import-and-serve.sh /graphhopper/import-and-serve.sh
RUN chmod +x /graphhopper/import-and-serve.sh

# FEN-740: NO build-time graph bake. The graph is imported ONCE at runtime onto the
# persistent /data volume by import-and-serve.sh (the runtime container has normal
# egress + RAM, unlike the RAM-tight/egress-flaky Coolify builder where the FEN-602
# bake silently failed). The build stays fast and deterministic — JAR + config only.
# The region + import heap are RUNTIME env (GH_OSM_URL / GH_IMPORT_OPTS in compose),
# so changing the region needs no rebuild — just a fresh volume.

EXPOSE 8989

# Import-once-then-serve at runtime (see import-and-serve.sh).
ENTRYPOINT ["/graphhopper/import-and-serve.sh"]
