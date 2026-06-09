# ADR 0002 — R2: Routing engine for real road-snapped referencing

- **Status:** Accepted (FEN technical decision). Confirms the PO recommendation on [FEN-490](/FEN/issues/FEN-490) (plan rev 2, accepted by Alexis). Execution gated to [FEN-504](/FEN/issues/FEN-504); infra provisioning delegated to DevOps.
- **Date:** 2026-06-09
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
(child issue of FEN-502, blocks FEN-504).

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
