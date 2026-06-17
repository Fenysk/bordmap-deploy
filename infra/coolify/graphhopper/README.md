# Bordmap R2 — GraphHopper routing service (FEN-507)

Self-hosted [GraphHopper](https://www.graphhopper.com/) (France extract) provisioned
as a **separate Coolify resource**, reachable only on the internal Coolify network.
Implements ADR [0002](../../../docs/adr/0002-r2-routing-engine.md) decision **D-R2**.
Unblocks the routing executor [FEN-504](/FEN/issues/FEN-504).

## What this is

| File | Role |
|---|---|
| `Dockerfile` | builds on official `graphhopper/graphhopper:8.0` (multi-arch), bakes config + entrypoint |
| `config.yml` | engine config: `bordmap_road` profile, inline custom model, SRTM elevation, MMAP |
| `import-and-serve.sh` | downloads the France PBF to the volume once, then import-or-serve |
| `docker-compose.graphhopper.yml` | the standalone Coolify resource (own 4 GB limit, ≥20 GB volume, no public domain) |

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
4. **Deploy.** The first deploy downloads the ~4.5 GB France PBF and runs the graph
   import — expect **30–90 min** on a NAS (healthcheck `start_period` is 5400 s to
   cover it). The graph cache persists on the `graphhopper-data` volume, so restarts
   only serve (fast, no re-import).

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
curl -s "http://bordmap-graphhopper:8989/route?point=45.188,5.724&point=45.196,5.735\
&profile=bordmap_road&algorithm=alternative_route&alternative_route.max_paths=3\
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
