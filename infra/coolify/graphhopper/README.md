# Bordmap R2 — GraphHopper routing service (FEN-507)

Self-hosted [GraphHopper](https://www.graphhopper.com/) (France extract) provisioned
as a **separate Coolify resource**, reachable only on the internal Coolify network.
Implements ADR [0002](../../../docs/adr/0002-r2-routing-engine.md) decision **D-R2**.
Unblocks the routing executor [FEN-504](/FEN/issues/FEN-504).

## What this is

| File | Role |
|---|---|
| `Dockerfile` | builds GraphHopper 8.0 from the release JAR (multi-arch), bakes config + entrypoint. **No build-time graph bake** (FEN-740) |
| `config.yml` | engine config: `bordmap_road` profile, inline custom model, SRTM elevation, MMAP. `graph.location` + SRTM cache on the **persistent `/data` volume** |
| `import-and-serve.sh` | imports the regional graph onto `/data` **once**, then serves; later redeploys serve the persisted graph with no re-import |
| `docker-compose.graphhopper.yml` | the standalone Coolify resource (`mem_limit: 3g`, persistent `graphhopper-data` volume, no public domain) |

## Graph persistence model (FEN-740)

The graph cache lives on the **persistent `graphhopper-data` volume** (`/data/graph-cache`),
not in the image. On the **first** deploy `import-and-serve.sh` downloads the regional
PBF and runs the import once (a few minutes for Rhône-Alpes), writing the graph onto the
volume. **Every subsequent redeploy/recreate** finds the graph already on the volume and
**serves immediately — no re-import**. This replaced the FEN-602 "bake at build" design,
which silently produced an empty cache and (even when it worked) landed it in the
writable image layer that a recreate discards, forcing a ~10 min re-import on every deploy.

**Switching region (FEN-599):** changing `GH_OSM_URL` does **not** auto-rebuild — the
volume already holds the old region's graph. To switch, **wipe the `graphhopper-data`
volume** (or its `/data/graph-cache` + `/data/srtm` dirs) and redeploy; the next boot
re-imports the new region once.

The app/Convex side (`GRAPHHOPPER_URL`) is wired in `docker-compose.coolify.yml`,
`docker/app-entrypoint.sh`, and `.env.example` — inert until FEN-504 ships the
`computeRoutes` action.

## ⚠️ NAS resource gate (do this FIRST)

Per ADR §Infra the France build needs, on the Coolify host (Synology NAS):

- **Disk:** ≥ **20 GB** free on the volume's disk (PBF ~4.5 GB + graph cache ~3–5 GB
  + SRTM ~1–2 GB, with headroom).
- **RAM:** **~4 GB** steady-state runtime; the one-time import wants **~6–8 GB**
  (MMAP caps the JVM heap, but mmap pages still count toward the cgroup).

**If the NAS cannot spare ~4 GB RAM + ~20 GB disk → do NOT force it. Escalate to the
board** (the ADR's documented fallback is **OSRM without elevation**, D-R1, lighter
footprint). Check before provisioning:

```sh
# Coolify API exposes the server; confirm free RAM/disk on the target server first.
# (or SSH to the NAS): free -g ; df -h /var/lib/docker
```

## Provisioning on Coolify

GraphHopper is its **own** resource in the Bordmap Coolify project
(`mbw8fq4xd475qc35hln9ryq0`, env `amdffi9rkbk785eva1f3z9b2`). Create it as a
**Docker Compose** resource:

1. **New Resource → Docker Compose**, same project/environment as the app.
2. **Source:** the same git source the app uses (`coolify-wire-source.mjs` snapshot
   repo). **Base directory:** repo root. **Compose file:**
   `/infra/coolify/graphhopper/docker-compose.graphhopper.yml`.
3. **Network:** turn **"Connect To Predefined Network" ON** (this resource AND the
   Bordmap app resource). That puts both on the shared `coolify` bridge network so
   the app/convex-backend resolve `bordmap-graphhopper` by name. **Do NOT** assign a
   public domain — this service stays internal.
4. **Deploy.** The first deploy downloads the regional PBF (Rhône-Alpes ~0.4 GB,
   FEN-599) and runs the graph import once — a few minutes (healthcheck `start_period`
   is 1800 s to cover it). The graph persists on the `graphhopper-data` volume, so
   **every later redeploy serves immediately with no re-import** (FEN-740).

### First-import RAM

The compose sets `mem_limit: 4g` (runtime target). MMAP keeps the heap small, but if
the **first** import OOM-kills (graph build is the peak), temporarily raise the
GraphHopper resource memory limit to **8g** in Coolify, deploy once to build + persist
the cache, then restore **4g**. Subsequent restarts serve from the cache and stay well
under 4 GB.

## Completeness smoke (the AC)

From inside the Coolify network (e.g. `docker exec` into the app/convex-backend
container, or a one-off on the host attached to the `coolify` network):

```sh
# Two French points (Grenoble area) — expect snapped geometry + ascend/descend.
# Base routing, single itinerary (LM/alternative_route abandoned per board Option A,
# FEN-739); on-demand alternatives are a separate follow-up (FEN-800).
curl -s "http://bordmap-graphhopper:8989/route?point=45.188,5.724&point=45.196,5.735\
&profile=bordmap_road\
&elevation=true&points_encoded=false&instructions=false" | head -c 600
```

`./smoke.sh` (in this dir) runs that call and asserts: HTTP 200, ≥1 `paths[]`, 3-tuple
coordinates `[lng,lat,ele]`, and numeric `ascend`/`descend`. **Done** = a snapped
trace with elevation returns from the Coolify network.

## Status / next step (FEN-507)

Infra-as-code is committed. Live provisioning + import + smoke requires a
Coolify-API-token-bearing heartbeat (token starvation is armed via the issue
`projectId`). Sequence on the next token-bearing run: **(1)** confirm NAS RAM/disk
gate → escalate if short, **(2)** create the GraphHopper Coolify resource + predefined
network, **(3)** deploy + watch the import, **(4)** run the smoke above, **(5)** hand
off to FEN-504.
