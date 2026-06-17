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
# baked). All mutable data (OSM extract, graph cache, SRTM cache) lives on the
# runtime VOLUME mounted at /data.
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

# FEN-602 (ADR Amendment 1): BAKE the graph cache AT BUILD so the runtime container
# only SERVES (no cold import → no runtime OOM that took down the live NAS stack in
# FEN-601; a build-time OOM only fails the build and Coolify keeps the old stack up).
# Region is a build ARG (default Rhône-Alpes — FEN-599: never full France on the NAS).
# Heap is CAPPED and graph.dataaccess=MMAP (config.yml) so the import footprint stays
# bounded; SRTM elevation is fetched here too and baked at /graphhopper/srtm. All
# outputs land on IMAGE paths under /graphhopper (config.yml), never /data, so no
# runtime volume can shadow them.
ARG GH_OSM_URL=https://download.geofabrik.de/europe/france/rhone-alpes-latest.osm.pbf
# Import heap is HARDCODED to 1g in the RUN below (Coolify did not honor the
# build-arg — it ran -Xmx2g — and the NAS builder is RAM-tight). 1g matches what
# the prior GH import used successfully; MMAP keeps the rest off-heap.
# Download the regional PBF, build the graph cache with a CAPPED heap + MMAP, then
# drop the PBF (only the import needs it — the serve command loads graph-cache and
# ignores datareader.file). No mid-RUN comments: a `#` line inside a `\`-continued
# RUN is a Dockerfile parse gotcha.
# FEN-601 diagnostic: capture the WHOLE bake to /graphhopper/bake.log and let the
# RUN always succeed (no set -e on the outer shell), so the image always builds
# even when the import fails. The serve entrypoint copies bake.log to the shared
# `diag` volume → readable at /diag/gh-bake.log (Coolify build logs are not exposed
# via the API). Revert to fail-fast once the import is proven.
# FEN-605: BuildKit cache mount for the PBF download. On cache miss the PBF is
# downloaded from Geofabrik and stored in the BuildKit cache volume (persists across
# deploys on the same builder). On cache hit the copy is near-instant, making LM
# rebuilds feasible within Coolify's build timeout.
RUN --mount=type=cache,target=/pbf-cache,id=gh-pbf-cache,sharing=locked \
  set -ux; mem=$( (free -m 2>/dev/null || true) ); \
  ( set -eux; \
    echo "host mem at build start:"; echo "${mem}"; \
    CACHE_PBF="/pbf-cache/osm.pbf"; \
    if [ -f "${CACHE_PBF}" ]; then \
      echo "PBF cache hit — copying from ${CACHE_PBF}"; \
      cp "${CACHE_PBF}" /graphhopper/osm.pbf; \
    else \
      echo "PBF cache miss — downloading from ${GH_OSM_URL}"; \
      wget -q -O "${CACHE_PBF}.tmp" "${GH_OSM_URL}"; \
      mv "${CACHE_PBF}.tmp" "${CACHE_PBF}"; \
      cp "${CACHE_PBF}" /graphhopper/osm.pbf; \
    fi; \
    du -h /graphhopper/osm.pbf; \
    java -Xmx2g -jar /graphhopper/graphhopper.jar import /graphhopper/config.yml; \
    du -sh /graphhopper/graph-cache; \
    rm -f /graphhopper/osm.pbf; \
    echo "BAKE_OK" \
  ) > /graphhopper/bake.log 2>&1; echo "BAKE_EXIT=$?" >> /graphhopper/bake.log; \
  tail -n 30 /graphhopper/bake.log

EXPOSE 8989

# Serve-only at runtime (graph already baked above).
ENTRYPOINT ["/graphhopper/import-and-serve.sh"]
