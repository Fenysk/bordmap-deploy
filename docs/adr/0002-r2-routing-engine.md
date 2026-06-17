# ADR 0002 — R2: Routing engine for real road-snapped referencing

- **Status:** Accepted (FEN technical decision). Confirms the PO recommendation on [FEN-490](/FEN/issues/FEN-490) (plan rev 2, accepted by Alexis). Execution gated to [FEN-504](/FEN/issues/FEN-504); infra provisioning delegated to DevOps. **D-R2 amended 2026-06-16 — see [Amendment 1](#amendment-1--2026-06-16-fen-602-d-r2-topology-revised) (separate-resource topology proved unreachable on Coolify 4.1.2 → co-located service with a build-baked graph).**
- **Date:** 2026-06-09 (amended 2026-06-16)
- **Owner:** Founding Engineer (FEN-502)
- **Context refs:** PO plan FEN-490 §3/§5 (CA-5.1/5.2/5.3), `app/components/RouteMap.tsx`, `convex/schema.ts`, `convex/routes.ts`, `app/lib/shared/route.ts`. Bordmap stack: TanStack Start + Convex, single Docker, Coolify deploy (see ADR 0001).

## Context

Bordmap R2 replaces the straight-line "vol d'oiseau" geometry with **real
road-snapped routing**: once Départ (D) and Arrivée (A) are placed, the app must
auto-compute one or more itineraries that follow the road network, expose
distance + elevation, let the user tap-select the final line, and (Q1 board =
OUI) add a via-point when no candidate matches the real descente.

The data model is already routing-ready: `routes.path?: Array<LatLng>` exists
(`convex/schema.ts:49`) — today empty (hence the straight line). Real routing =
**fill `path`** with the snapped polyline + persist elevation. No geometry-schema
overhaul, only an additive elevation delta.

The hard constraint is **Bordmap autonomy**: single-Docker app + Coolify deploy,
**no external paid routing API** (board ruling 2026-06-07). The engine must
self-host.

## Decision

### D-R1 — Engine: GraphHopper self-hosted (OSRM fallback)

We adopt **GraphHopper** (OSS, Apache-2.0, single Java process + OSM extract).
Justification against the PO acceptance criteria:

| Criterion | Requirement | GraphHopper |
|---|---|---|
| **CA-5.1** | self-host, single container, Coolify, no paid API | ✅ one jar + one OSM extract + SRTM cache → one container; same Coolify pattern as the app |
| **CA-5.2** | snap to road network + **alternatives** + **elevation** | ✅ `/route` snaps; `algorithm=alternative_route`; `graph.elevation.provider=srtm` gives native ascent/descent |
| **CA-5.3** | profile for **paved descent**, direction-agnostic | ✅ server-side **custom model** (prefer paved, exclude motorway/private) on a direction-agnostic base vehicle |

**Fallback (documented, not chosen):** OSRM — lighter, but elevation needs a
separate post-processing pipeline and alternatives are weaker. We flip to OSRM
**only** if native elevation is dropped from MVP scope (board Q3) and the
GraphHopper footprint proves unworkable on the NAS. **Rejected:** Valhalla
(tile-build ops overhead) and any external API (breaks autonomy / quota).

### D-R2 — Topology: GraphHopper is a SEPARATE Coolify service

GraphHopper runs as its **own container**, **not** bundled into the app's single
image. Rationale:

- Different runtime (JVM vs Node) and a multi-GB memory profile that should not
  share the app container's lifecycle or limits.
- The graph build is a heavy one-time/occasional step; isolating it keeps app
  rebuilds fast and the app image small.
- It only needs to be reachable on the **internal Coolify network** — never
  exposed publicly. The Convex backend calls it server-side (see contract).

This is the AC-4 "déploiement séparé" path; provisioning is delegated to DevOps
(child issue of FEN-502, blocks FEN-504). **⚠ This topology was superseded on
2026-06-16 — see [Amendment 1](#amendment-1--2026-06-16-fen-602-d-r2-topology-revised).**

### D-R3 — Call path: Frontend → Convex action → GraphHopper (internal)

```
RouteMap (browser)
  └─ useAction(api.routing.computeRoutes, { start, end, via? })
       └─ Convex action  (server-side fetch, GRAPHHOPPER_URL internal)
            └─ GET/POST {GRAPHHOPPER_URL}/route   (paved profile)
            └─ normalises → RouteCandidate[]  (no straight-line fallback)
```

The browser **never** calls GraphHopper directly: the service URL stays internal
(no CORS, no public exposure), the response is normalised in one place, and the
geometry helpers (`pathLengthMeters`) already live in Convex. Persistence reuses
the existing `routes.create` mutation with the elevation delta.

## Contract — service-facing (GraphHopper HTTP)

Engine config (DevOps owns the exact `config.yml`):

- `graph.elevation.provider: srtm`, `graph.elevation.cache_dir: /data/srtm` (~30 m
  resolution — board Q3 accepts "approximatif" for the "si dispo" elevation).
- Base vehicle **`roads`** (direction-agnostic: ignores oneway/access so a descent
  can be referenced in either travel sense) with a named profile `bordmap_road`
  carrying a server-side **custom model** so requests stay simple and CH can be
  precompiled:

```jsonc
// custom_model baked into the bordmap_road profile (config.yml)
{
  "priority": [
    { "if": "road_class == MOTORWAY || road_class == TRUNK", "multiply_by": "0" },
    { "if": "road_access == PRIVATE || road_access == NO",   "multiply_by": "0" },
    { "if": "surface == PAVED || surface == ASPHALT || surface == CONCRETE", "multiply_by": "1.0" },
    { "else": "", "multiply_by": "0.5" }   // unpaved/unknown allowed but de-prioritised
  ]
}
```

Request (alternatives case, 2 points D→A):

```
GET /route?point={Dlat},{Dlng}&point={Alat},{Alng}
          &profile=bordmap_road
          &algorithm=alternative_route&alternative_route.max_paths=3
          &elevation=true&points_encoded=false&instructions=false&calc_points=true
```

Response 200 → `{ paths: [ { distance, points: { coordinates: [[lng,lat,ele],…] }, ascend, descend }, … ] }`.

**Via-point gotcha (must respect):** GraphHopper's `alternative_route` algorithm
supports **exactly 2 points**. With a via-point (3 points: D→via→A) alternatives
are **not** available — the engine returns a **single** re-snapped route through
the via. This matches CA-2.4 semantics (via-point = precision override → one
corrected line) and is the documented behaviour the executor must implement: when
`via` is set, drop `algorithm=alternative_route` and request the single 3-point
route.

## Contract — app-facing (Convex action)

```ts
// convex/routing.ts  (new)
export const computeRoutes = action({
  args: {
    start: { lat: number, lng: number },
    end:   { lat: number, lng: number },
    via?:  { lat: number, lng: number },   // CA-2.4 / board Q1 = OUI au MVP
  },
  // returns ComputeRoutesResult
})
```

Normalised candidate (shared type, add to `app/lib/shared/route.ts`):

```ts
export interface RouteElevation {
  gainMeters: number      // D+ (ascend)
  dropMeters: number      // D− (descend)
  avgGradePct: number     // signed net grade over the line, % (descent ⇒ negative)
}

export interface RouteCandidate {
  path: Array<LatLng>     // snapped polyline, ordered D→A (fills routes.path)
  lengthMeters: number    // routing distance (CA-3.2: real geometry, not vol d'oiseau)
  elevation: RouteElevation | null   // null when SRTM unavailable (CA-3.1 "si dispo")
  isPrimary: boolean      // pre-selected default (CA-2.2) — GraphHopper paths[0]
}

export type ComputeRoutesResult =
  | { ok: true; candidates: Array<RouteCandidate> }       // 1..3 (1 when via set)
  | { ok: false; error: RoutingError; message: string }   // CA-1.3: no silent fallback

export type RoutingError =
  | 'NO_ROUTE'            // GraphHopper "Connection between locations not found"
  | 'POINT_OFF_NETWORK'   // "Cannot find point N" → point hors réseau
  | 'ROUTING_UNAVAILABLE' // 5xx / timeout / service down
```

### Error mapping (AC-2 / CA-1.3)

| GraphHopper | Convex result | Frontend (UX) |
|---|---|---|
| 200, ≥1 path | `{ ok:true, candidates }` | render tappable lines, primary pre-highlighted |
| 400 `Connection between locations not found` | `{ ok:false, error:'NO_ROUTE' }` | "Aucun itinéraire — repositionnez D ou A" |
| 400 `Cannot find point` | `{ ok:false, error:'POINT_OFF_NETWORK' }` | "Ce point n'est pas sur une route — déplacez-le" |
| 5xx / timeout (≥10 s) | `{ ok:false, error:'ROUTING_UNAVAILABLE' }` | "Service de routage indisponible, réessayez" |

**Never** fall back to a straight line silently (CA-1.3).

## Schema delta (AC-3)

Additive change to the `routes` table (`convex/schema.ts`). The existing
`elevationDrop?` field is **unused** (MVP never wrote it) → rename for unit
clarity and add the two missing fields:

```ts
// REMOVE: elevationDrop: v.optional(v.number())
elevationGainMeters: v.optional(v.number()), // D+
elevationDropMeters: v.optional(v.number()), // D−  (was elevationDrop)
avgGradePct:         v.optional(v.number()), // signed net grade %, negative on descent
```

- All three optional → graceful when SRTM is unavailable (CA-3.1 "si dispo").
- `lengthMeters` stays server-derived (haversine over the snapped `path`, already
  in `routes.create`) — consistent with CA-3.2 and avoids trusting client numbers
  for distance. Elevation values are accepted as `create` args (cannot be derived
  from lat/lng alone), echoing the candidate the user selected.
- `routes.create` gains optional args `elevationGainMeters`, `elevationDropMeters`,
  `avgGradePct`.

No rename collisions: `elevationDrop` is referenced only in the schema/shared
types, never persisted, so this is a pure forward edit (no data migration).

## Infra footprint — France-only (AC-4)

MVP extract = **France** only (board pilot region). Estimates (Geofabrik
`france-latest.osm.pbf`):

| Resource | Estimate | Note |
|---|---|---|
| OSM extract (.pbf) | ~4–4.5 GB | downloaded to a volume |
| Graph build RAM (one-time import) | ~6–8 GB JVM | use `MMAP` dataaccess to cap; can run as a build step |
| Runtime RAM | ~2–4 GB | one profile + LM/CH; container limit **4 GB** |
| Built graph cache (disk) | ~3–5 GB | persisted on volume to skip re-import on restart |
| SRTM elevation cache (disk) | ~1–2 GB | downloaded on demand, cached on volume |
| **Total persistent volume** | **~12–15 GB** | provision ≥ 20 GB headroom |

DevOps decides the concrete Coolify service definition, volume, memory limit, and
whether import runs as an init/build step or a manual one-off. Captured in the
DevOps child issue.

## Amendment 1 — 2026-06-16 (FEN-602): D-R2 topology revised

**Decision:** ratify **Option A** from [FEN-602](/FEN/issues/FEN-602). D-R2's
"GraphHopper as a SEPARATE Coolify resource" is **superseded** by **GraphHopper
co-located as a service in the main Coolify compose (`docker-compose.coolify.yml`),
with the graph cache BAKED AT IMAGE BUILD**. D-R1 (engine = GraphHopper), D-R3
(call path), and the entire HTTP/Convex/schema contract above are **unchanged**.

### Why the original D-R2 failed (proven on Coolify 4.1.2, FEN-601)

Both candidate topologies had a *proven* blocker:

1. **Separate Coolify resource (original D-R2).** Coolify 4.1.2 strips
   `container_name`, and cross-resource DNS on the predefined `coolify` network does
   **not** deliver GraphHopper to `convex-backend`. A probe run *inside*
   convex-backend reached `app:3000` / `proxy:80` / `convex-backend:3210` but every
   GraphHopper name failed (DNS error, or `graphhopper` mis-resolved to the app).
   → the computeRoutes action (D-R3) can never reach the engine. **Blocker is in the
   one property D-R2 needed most (reachability).**
2. **Co-located, importing the graph at RUNTIME.** DNS resolves (same-compose
   services share the `default` network and resolve by service name — proven: app ↔
   convex-backend ↔ proxy already do). BUT the cold Rhône-Alpes import spikes RAM and
   **OOM-killed the whole NAS stack** (site → 503). See [[bordmap-graphhopper-region-oom]].

### The decision: co-locate + bake the graph at build (Option A)

Move GraphHopper into `docker-compose.coolify.yml` as a `graphhopper` service so
`convex-backend` reaches it by **same-compose service name** (`http://graphhopper:8989`)
— the reachability that the separate-resource path could not provide. Eliminate the
runtime OOM by building the graph cache **during `docker build`** instead of on first
boot: the runtime container only *serves* a pre-built graph (~0.5 g working set, no
import spike).

**Why this is safe (blast radius):** the heavy import now runs in the **build**, not
in the live container. A build-time OOM **fails the build** and Coolify keeps the
*old* stack running (swap happens only after a successful build) — the site stays at
200. This is strictly safer than runtime import, which took the live site down. The
residual risk (the build itself OOMs on the RAM-tight NAS) is **recoverable** and
escalates cleanly to Option C (NAS RAM / maintenance window) without any outage.

**What we keep from D-R2's intent:** GraphHopper still has its **own container,
its own JVM, and its own `mem_limit`** — the lifecycle/limit isolation that
motivated D-R2 — just inside the main compose rather than a separate Coolify
resource. We give up *only* the separate-resource boundary, which is precisely the
thing Coolify 4.1.2 broke.

**Rejected alternatives:**
- *Option B (stay separate, find a Coolify network fix — `custom_network_aliases`
  etc.).* FEN-601 already proved cross-resource DNS does not deliver on 4.1.2; a fix
  is speculative and would burn open-ended diagnostic cycles on a quirky Coolify
  version. Not worth it when the isolation benefit is moot under unreachability.
- *Option C (raise NAS RAM / maintenance window for a co-located runtime import).*
  Not in our control (Alexis's hardware) and doesn't remove the runtime-OOM class of
  failure. **Retained as the fallback** *iff* Option A's build-time import OOMs.

### Implementation contract (for the FEN-601 executor)

Traceable to CA-5.1 (self-host, single Coolify deploy, no paid API) and CA-4
(internal-only, never public). Concrete, no-guessing spec:

1. **`infra/coolify/graphhopper/Dockerfile`** — add build stages *after* the JAR
   copy: (a) `wget` the regional PBF (`GH_OSM_URL`, default Rhône-Alpes — keep the
   region per [[bordmap-graphhopper-region-oom]], do **not** restore France); (b) run
   `java -Xmx<cap> -jar graphhopper.jar import config.yml` so the graph cache is built
   into an **image path OUTSIDE any runtime volume**, e.g. `/graphhopper/graph-cache`.
   Cap the build JVM heap with `-Xmx` and keep `graph.dataaccess=MMAP` so the build
   footprint stays bounded and a failure stays a build failure.
2. **`config.yml`** — point `graph.location` (and `datareader.file`) at the baked
   **non-`/data`** path so a mounted `/data` volume cannot **shadow** the baked graph.
   Bake the SRTM cache at build too (or keep it on a read-only path) so runtime has no
   network dependency.
3. **Entrypoint** — the runtime no longer imports: drop the download/import branch in
   `import-and-serve.sh` (or add a `serve-only` entrypoint) → just
   `exec java … server config.yml`. No `/data` graph dependency at runtime.
4. **`docker-compose.coolify.yml`** — add a `graphhopper` service (build context
   `infra/coolify/graphhopper`) on the compose `default` network, with its own
   `mem_limit` (~1 g — serve-only) and `JAVA_OPTS`. No public domain, no host port.
   The existing GH healthcheck (route-with-`ascend`) carries over.
5. **Env wiring** — set `GRAPHHOPPER_URL` default to `http://graphhopper:8989`
   (same-compose service name), replacing `http://bordmap-graphhopper:8989`. Drop the
   `convex-backend` join to the external `coolify` network if nothing else needs it.
6. **Remove temp diagnostics** (FEN-601): the `routingDiag:probe` action
   (`convex/routingDiag.ts`) and the `/diag/bootstrap.txt` path + `diag` volume, once
   GraphHopper is reachable.
7. **Verify (definition of done):** `convex-backend`'s computeRoutes reaches
   `http://graphhopper:8989/route?...&profile=bordmap_road&elevation=true` and gets a
   200 with `ascend` on the live NAS deploy — the FEN-601 blocker is retired.

**Note for the executor:** redeploy is the two-step from [[bordmap-coolify-deploy-state]]
(`coolify-wire-source.mjs` to push HEAD → deploy-repo main, **then** `coolify-deploy.mjs`),
else the rebuild uses STALE main. Build-time graph import is unverifiable in the
sandbox (no docker daemon, [[bordmap-docker-validation-constraint]]) — this needs
live iteration on the NAS, which is why implementation stays with the FEN-601 owner.

## Consequences

- **Positive:** native elevation + alternatives + custom model with no recompile;
  one extra container on the existing Coolify network; the app/Convex contract is
  framework-agnostic and testable with a mocked `computeRoutes`.
- **Negative / watch:** GraphHopper memory footprint on the NAS (mitigated by
  France-only + MMAP + 4 GB limit + OSRM fallback); SRTM ~30 m elevation is
  approximate (board Q3 accepts); via-point disables alternatives (documented,
  expected UX).
- **Risk R-routing-host:** if the NAS cannot spare ~4 GB + ~15 GB disk → escalate
  to board with the OSRM-no-elevation fallback (lighter) as the mitigation.
