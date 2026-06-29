# ADR 0003 — Freebord profile: make pedestrian ways (montées/footways) routable

- **Status:** Proposed (FEN technical decision, FEN-1310). **Gated on CEO approval before deploy** — the CEO asked to review this reco before any routing redeploy (gros impact routing). Builds on ADR 0002 (engine = GraphHopper, profile `bordmap_road`, base vehicle `roads`); does **not** change the engine, topology, call path, or the app/Convex contract.
- **Date:** 2026-06-29
- **Owner:** Founding Engineer (FEN-1310)
- **Context refs:** `infra/coolify/graphhopper/config.yml:30` (the root cause), `convex/routing.ts`, ADR 0002 Amendment 2 (one-time runtime import on `graphhopper-data` volume), [FEN-949](/FEN/issues/FEN-949) (the route-edit loop this likely unblocks). Memories: `bordmap-gh-startup-compile-and-path-details`, `bordmap-graphhopper-region-oom`, `bordmap-ch-disabling-allowed-boot-kill`.

## Context — the bug (CEO repro, live)

Alexis cannot route over **la Montée du Chemin Neuf** (Vieux-Lyon). Engine test:
even with a `via` posed **directly on it** (`45.7596, 4.8250`), the route stays
**~89 m away** and never uses the montée. No edit tool (drag/via/draw) can force a
route onto a way that the engine cannot see — **the montée is not in the routable
graph at all.**

## Root cause (diagnosed — config-level, conclusive)

`infra/coolify/graphhopper/config.yml:30`:

```yaml
import.osm.ignored_highways: footway,cycleway,path,pedestrian,steps
```

This drops **every pedestrian way** (`highway=footway|cycleway|path|pedestrian|steps`)
from the graph **at import time**. The Montée du Chemin Neuf — like most Vieux-Lyon
montées — is tagged `highway=steps` and/or `highway=footway`/`pedestrian`, so it is
**never imported as an edge**. The `via` snaps to the nearest *motor* road ~89 m away
because that is the closest thing in the graph.

This was a *deliberate* choice when the profile was conceived as "motor roads only"
(spots referenced on roads/parking/hills) — the comment at `config.yml:28-29` says so,
and it shrank the import to fit the RAM-tight NAS. **That premise is wrong for Freebord:**
a freebord is ridden **on foot-class infrastructure** — montées, footways, pedestrian
streets, open traboules — minus real stairs. The exclusion list is the single blocker.

**Why the `roads` vehicle is not the problem.** `bordmap_road` uses base vehicle
`roads`, which is intentionally access- and direction-agnostic: it grants access to
**any** way carrying a `highway` tag (the whole reason ADR 0002 picked it — a descente
can be referenced in either travel sense). So once a footway/montée is **imported**,
`roads` will traverse it. The only thing standing in the way is the import-time
`ignored_highways` filter. **No vehicle/base change is required.**

## Diagnosis refinement — live OSM evidence (FEN-1310, Overpass 2026-06-29)

Querying OSM around the CEO's exact test point `45.7596, 4.8250` sharpens (and
confirms) the above. The nearest 7 ways (34–47 m) are **all `highway=pedestrian`** and
**all in the exclusion list**:

| dist | way | highway | note |
|---|---|---|---|
| 34.7 m | Place de la Trinité (221423608) | **pedestrian** | excluded |
| 36.4 m | **Montée du Gourguillon** (1233389877) | **pedestrian** | excluded — a classic Vieux-Lyon montée Alexis rides |
| 41.1 m | Rue Tramassac (221423609) | **pedestrian** | excluded |
| 47.0 m | Rue Mourguet (4378880) | **pedestrian** | excluded |
| **51.4 m** | **Montée du Chemin Neuf** (35018430) | **residential** | foot=yes, bicycle=yes, asphalt — **already routable** |

**Two corrections to the first-pass hypothesis, neither of which changes the fix:**

1. The *named* "Montée du Chemin Neuf" way (35018430) is **`highway=residential`**, not a
   pedestrian class — so it is **already in the graph** and routable. The reason the CEO's
   `via` stuck ~50–89 m away is that **his test coordinate sits in the pedestrian core**
   (Place de la Trinité / Montée du Gourguillon), whose ways are excluded; the nearest
   *routable* edge is the residential Chemin Neuf ~51 m off, so the via snaps there. The
   "montée not in the graph" intuition was right about the **pedestrian network at that
   point**, not about the one residential segment that happens to carry the name.
2. The relevant excluded ways are **`pedestrian`, not `steps`** — so the CEO's guardrail
   (#3: "if it's `highway=steps` it stays excluded, escalate before prod") **does not
   bite**: option (a) imports `pedestrian`/`footway`/`path` and these ways become routable.
   The only nearby `steps` is *Impasse Turquet* (982350625) — correctly kept out.

So option (a) **resolves the test case**: once Place de la Trinité / Montée du Gourguillon
are imported, a `via` at `45.7596, 4.8250` snaps onto the pedestrian way within a few
metres instead of 51–89 m. **Surface caveat:** most of these montées are
`unhewn_cobblestone`/`sett`/`paving_stones` → the custom_model's `surface` rule gives them
priority `0.5` (allowed, de-prioritised vs. asphalt) — they route, just aren't *preferred*
over a paved parallel. Acceptable for MVP (cobble montées are exactly what Alexis wants to
ride); revisit only if he sees the engine dodge a cobbled montée for a paved detour.

## Decision

**Un-ignore the rideable pedestrian classes at import; keep only real stairs out.**

```yaml
# config.yml — was: footway,cycleway,path,pedestrian,steps
import.osm.ignored_highways: steps
```

- `footway`, `pedestrian`, `path` → **imported** → montées/passages become routable.
- `cycleway` → **imported** too: cycleways are prime freebord surface (flat, paved).
- `steps` → **stays excluded** → real escaliers are never routable (Freebord ≠ stairs).

The `bordmap_road` custom_model is **unchanged**. Its existing rules already do the
right thing on the newly-admitted ways:
- `road_class == MOTORWAY || TRUNK → 0` (unaffected; pedestrian ways aren't motorways).
- `road_access == PRIVATE || NO → 0` (keeps genuinely private traboules out — see Risks).
- `surface PAVED/ASPHALT/CONCRETE → 1.0`, else `0.5` (rough urban `path` is allowed
  but de-prioritised vs. the paved montée — exactly the Freebord preference).

### Why exclude `steps` at IMPORT, not via a custom_model rule

We could instead import steps and exclude them with `road_class == STEPS → 0` in the
custom_model. We **do not**, for two reasons:
1. **Boot-safety.** Custom_model expressions compile at GH **server startup**; a bad
   one boot-kills the whole stack (FEN-826/955/958 — the slope saga). Import-level
   exclusion has **zero** startup-compile surface. `road_class==STEPS` is a *proven-safe*
   class (same family as the working MOTORWAY rule), so it is a safe **optional**
   defense-in-depth — but the import filter alone is sufficient and bulletproof.
2. **Smaller graph.** Not importing steps keeps the edge count (and import RAM) down.

### Why NOT switch the base to vehicle `foot` (option considered, rejected)

`foot` would also reach footways, but it is a **larger blast radius**: every existing
on-road Freebord line would be recomputed under pedestrian semantics (prefers
sidewalks/footways even where the rider wants the carriageway), and `foot` routes over
`steps` by default — re-introducing the very stairs we want gone, forcing us *back* into
a startup-compiling `road_class==STEPS` custom_model rule. Staying on `roads` changes
**nothing** for existing road geometry and adds the pedestrian network purely additively.
`roads` already gives us the oneway-agnostic behaviour `foot` would (contre-sens is
handled). Net: same upside, far less risk. **Rejected.**

## Cost — this requires a graph RE-IMPORT (the only heavy part)

`ignored_highways` is read **at import**. Per ADR 0002 Amendment 2, the graph is
imported **once per fresh `graphhopper-data` volume** and served on every boot
thereafter — a warm volume **never re-imports**. So shipping this change means the
operator must **wipe `/data/graph-cache` (the `graphhopper-data` volume)** so
`import-and-serve.sh` re-imports with the new filter. A config redeploy **without**
wiping the volume is a no-op (stale graph) — this is the documented loop trap
(`bordmap-gh-startup-compile-and-path-details` / FEN-740).

Adding footway/path/pedestrian/cycleway grows the Rhône-Alpes graph (denser in urban
Lyon). Import RAM rises accordingly; that is the one real risk (below).

## Risks

| # | Risk | Mitigation |
|---|------|-----------|
| R1 | **Import OOM / boot-kill** on the RAM-tight NAS — the larger graph exceeds `GH_IMPORT_OPTS` (`-Xmx1500m`). Re-arming the OOM wall is the #1 known loop (`bordmap-graphhopper-region-oom`). | MMAP is already on (`graph.dataaccess: MMAP`), which caps heap. **Verify the re-import on the NAS TEST env / a throwaway volume FIRST**, measuring peak RAM + import time, before touching prod. If it OOMs: bump `GH_IMPORT_OPTS` heap within the NAS budget, else narrow the region. The import runs in the runtime container; a failed import `sleep`s (no crash-loop) and the **old served graph is untouched until the new one succeeds** — the live site is not taken down by a failed re-import. |
| R2 | **Genuinely-private montée/traboule excluded** by the existing `road_access == PRIVATE/NO → 0` rule (a foot=yes but access=private passage). | This is *correct* for closed traboules. For the Chemin Neuf case, confirm its `access`/`foot` tag during verification (step 1). If a *publicly-walkable* montée is wrongly excluded by a motor-oriented `access` tag, a **follow-up** can relax the rule for non-motor `road_class` — out of scope for this minimal fix; note it, don't pre-build it. |
| R3 | **Rough/unrideable `path`** (dirt trail) admitted into routing. | Already de-prioritised (`surface` rule → `0.5`, not excluded). Acceptable for MVP; can tighten to an exclusion later if Alexis sees bad lines. No boot risk (proven-safe class). |
| R4 | **Steps tagged as something else** (`highway=footway` + `step_count`, conveying=escalator) slip in. | Rare in Vieux-Lyon vs. plain `highway=steps`. Acceptable residual; revisit only if a stairway actually appears in a route. |

## Verification — definition of done (proves the CEO case)

1. **Tag check:** confirm the OSM `highway`/`access`/`foot` tag of Montée du Chemin Neuf
   (and 1-2 neighbours) in the Rhône-Alpes extract.
2. **Re-import** on a **non-prod** volume with `ignored_highways: steps`; capture peak
   import RAM + duration (R1 gate). Abort to mitigation if it OOMs.
3. **Engine proof:** a route with a `via` at `45.7596, 4.8250` **snaps onto the
   pedestrian way** (Place de la Trinité / Montée du Gourguillon, `highway=pedestrian`)
   **≤ ~a few metres** away (not 51–89 m), and the path geometry follows it — proving the
   newly-imported pedestrian edges are routable. Cross-check `GET /nearest?point=45.7596,4.8250&profile=bordmap_road`
   returns a snap distance of a few metres (was tens of metres). Also confirm a route that
   should use **Montée du Gourguillon** actually traverses it.
4. **Non-regression:** a known existing on-road Freebord line still computes the same
   on-road geometry (the `roads` base + unchanged custom_model guarantees this; spot-check
   one).
5. **Stairs stay out:** a `via` on a known `highway=steps` flight does **not** produce a
   route through it (it snaps off, as the montée used to).

Only after (2)+(3) pass on TEST do we do the prod two-step redeploy
(`coolify-wire-source.mjs` → `coolify-deploy.mjs`) **with the volume wiped**, and re-verify
(3) live on bordmap.fenysk.fr.

## Consequences

- **Positive:** the montées of Vieux-Lyon become routable — this is very likely the
  **root unblock of [FEN-949](/FEN/issues/FEN-949)** (the rues Alexis kept failing to
  trace are pedestrian montées that simply weren't in the graph). Minimal change: one
  config line + a one-time re-import. No profile/custom_model/boot-surface change, no
  oneway behaviour change, no LM/CH (the OOM/boot-kill walls stay down).
- **Negative / watch:** one larger re-import on the NAS (R1) — the sole real cost, gated
  by a TEST measurement. Possible over-eager admission of rough `path` (R3, de-prioritised
  not excluded) and the private-traboule edge (R2, follow-up).
- **Reversible:** restoring the old `ignored_highways` line + re-import rolls back cleanly.
