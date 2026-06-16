# Bordmap R2 — GraphHopper routing service (FEN-507)

Self-hosted [GraphHopper](https://www.graphhopper.com/) (**Rhône-Alpes** regional
extract — see *Region & footprint* below) provisioned as a **separate Coolify
resource**, reachable only on the internal Coolify network.
Implements ADR [0002](../../../docs/adr/0002-r2-routing-engine.md) decision **D-R2**.
Unblocks the routing executor [FEN-504](/FEN/issues/FEN-504).

> **FEN-599 (2026-06-16):** the engine repeatedly went `exited:unhealthy` from OOM
> on the France extract even after [FEN-519](/FEN/issues/FEN-519) raised the cgroup
> 4 → 5 GB. Root cause: MMAP page cache is charged to the container memory cgroup, so
> the limit must hold heap (~1.5 GB) **plus** the full resident graph (~3-5 GB for
> France) — France simply does not fit a NAS-reasonable cgroup. Fix (action
> pre-approved on the issue): **reduce the OSM extract to Rhône-Alpes** (the board
> pilot region), which shrinks the PBF ~4.5 GB → ~430 MB and the graph to ~0.5 GB.
> Memory cap dropped 5g → **2g** (still ample headroom; frees ~3 GB of NAS RAM).

## What this is

| File | Role |
|---|---|
| `Dockerfile` | builds on official `graphhopper/graphhopper:8.0` (multi-arch), bakes config + entrypoint |
| `config.yml` | engine config: `bordmap_road` profile, inline custom model, SRTM elevation, MMAP |
| `import-and-serve.sh` | downloads the regional PBF (per `GH_OSM_URL`) to the volume once, then import-or-serve |
| `docker-compose.graphhopper.yml` | the standalone Coolify resource (2 GB limit, few-GB volume, no public domain) |

The app/Convex side (`GRAPHHOPPER_URL`) is wired in `docker-compose.coolify.yml`,
`docker/app-entrypoint.sh`, and `.env.example` — inert until FEN-504 ships the
`computeRoutes` action.

## Region & footprint (Rhône-Alpes — FEN-599)

`GH_OSM_URL` selects the OSM extract; the default is the **Rhône-Alpes** regional
extract. The healthcheck and smoke route (Grenoble) is inside Rhône-Alpes, so the
board pilot region is fully covered.

| Resource | Rhône-Alpes (default) | France (old, OOM'd the NAS) |
|---|---|---|
| OSM PBF | ~430 MB | ~4.5 GB |
| Built graph cache (disk) | ~0.5 GB | ~3–5 GB |
| SRTM elevation cache | ~0.3–0.5 GB | ~1–2 GB |
| Resident graph (charged to cgroup) | ~0.5 GB | ~3–5 GB |
| `mem_limit` | **2 GB** | 5 GB (still rechute-OOM'd) |
| Volume free space needed | a few GB | ≥ 20 GB |
| First import time | < ~15 min | 60–90 min |

**Why not France:** MMAP keeps the JVM *heap* small, but the memory-mapped graph
pages are charged to the container's memory cgroup. So `mem_limit` must hold heap +
JVM overhead + the **entire** resident graph. France's ~3-5 GB graph drove the cgroup
past 5 GB under load and the kernel OOM-killed the JVM — repeatedly (FEN-519 → -599).
Rhône-Alpes fits with comfortable headroom at 2 GB.

### Region switch = WIPE THE VOLUME (gotcha)

`import-and-serve.sh` re-imports **only when `/data/graph-cache` is empty**. To switch
regions (e.g. back to France on a box with the RAM, or to another Geofabrik extract):

1. Set `GH_OSM_URL` in the Coolify env to the new extract URL.
2. **Wipe the volume** so the stale graph + old PBF are removed and re-import runs:
   recreate the `graphhopper-data` volume in Coolify (or, via NAS SSH:
   `docker volume rm <project>_graphhopper-data` after stopping the resource; or
   `rm -rf /data/graph-cache /data/region-latest.osm.pbf` inside the container's volume).
3. Raise `mem_limit` (and `GH_JAVA_OPTS=-Xmx…` for the import) to fit the new region —
   France needs > 5 GB and proved unreliable on the NAS; escalate before forcing it.
4. Redeploy and watch the import in the logs (`[graphhopper-init] …`).

> Skipping step 2 means the container keeps serving the OLD region's graph (and stays
> OOM-prone if that was France) — no error, just no change.

## ⚠️ Host resource gate (check before first deploy)

On the Coolify host (Synology NAS), Rhône-Alpes needs only ~2 GB RAM + a few GB disk —
comfortably within the budget that France blew past. Quick check:

```sh
# Coolify API exposes the server; confirm free RAM/disk on the target server first.
# (or SSH to the NAS): free -g ; df -h /var/lib/docker
```

If even Rhône-Alpes cannot be hosted, the ADR's documented fallback is **OSRM without
elevation** (D-R1, lighter) — escalate to the board / Founding Engineer (ADR owner).

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
4. **Deploy.** The first deploy downloads the ~430 MB Rhône-Alpes PBF and runs the
   graph import — expect **< ~15 min** on a NAS (healthcheck `start_period` is 1800 s to
   cover it + SRTM download). The graph cache persists on the `graphhopper-data` volume,
   so restarts only serve (fast, no re-import).

### First-import RAM

The compose sets `mem_limit: 2g` (runtime + import). For Rhône-Alpes the import peak
fits in 1g heap, so **no temporary bump is needed** (unlike the old France import). If
you switch to a larger region, see *Region switch* above — raise `mem_limit` and
`GH_JAVA_OPTS` to fit, and re-import on a wiped volume.

## Completeness smoke (the AC)

From inside the Coolify network (e.g. `docker exec` into the app/convex-backend
container, or a one-off on the host attached to the `coolify` network):

```sh
# Two French points (Grenoble area) — expect snapped geometry + ascend/descend.
curl -s "http://bordmap-graphhopper:8989/route?point=45.188,5.724&point=45.196,5.735\
&profile=bordmap_road&algorithm=alternative_route&alternative_route.max_paths=3\
&elevation=true&points_encoded=false&instructions=false" | head -c 600
```

`./smoke.sh` (in this dir) runs that call and asserts: HTTP 200, ≥1 `paths[]`, 3-tuple
coordinates `[lng,lat,ele]`, and numeric `ascend`/`descend`. **Done** = a snapped
trace with elevation returns from the Coolify network.

## Status / next step (FEN-599)

Region-reduction IaC is committed. Applying it to the live OOM'ing resource requires a
Coolify-API-token-bearing heartbeat (+ possibly NAS SSH to wipe the volume). Sequence on
the next credentialed run:

1. **Confirm OOM** in the GraphHopper container logs / `exited:unhealthy` state.
2. **Wipe the `graphhopper-data` volume** (recreate in Coolify, or `docker volume rm`
   via NAS SSH) — MANDATORY, else the stale France graph keeps serving (see *Region
   switch*). Verify `mem_limit: 2g` and the Rhône-Alpes `GH_OSM_URL` are picked up.
3. **Redeploy** the GraphHopper resource from this branch's snapshot and watch the
   import in the logs (`[graphhopper-init] …`, < ~15 min).
4. **Smoke:** `./smoke.sh` from the Coolify network → snapped trace + ascend/descend,
   and `running:healthy`. Then verify `routing:computeRoutes` returns paths (not
   `FETCH_ERR`) end-to-end (handback to FEN-518 / FEN-504 owners).
