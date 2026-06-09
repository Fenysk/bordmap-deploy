import { defineSchema, defineTable } from 'convex/server'
import { v } from 'convex/values'

export default defineSchema({
  /**
   * L1 — Users table (plan §3 of FEN-341).
   *
   * PII minimale: email + displayName. authId = Better Auth user ID (JWT `sub`
   * claim). The tokenIdentifier in Convex is `{issuer}|{authId}`, so
   * `routes.createdBy` stores the full tokenIdentifier for `by_creator` index.
   */
  users: defineTable({
    authId: v.string(),
    email: v.string(),
    displayName: v.string(),
    createdAt: v.number(),
    /** RGPD: timestamp (ms) when the user gave consent at registration. */
    rgpdConsentAt: v.optional(v.number()),
  })
    .index('by_auth_id', ['authId'])
    .index('by_email', ['email']),

  /**
   * L2 — Routes table (plan §2 of FEN-341).
   *
   * Vocabulary: descente = the hill (real world); route = one rideable line on
   * that hill (unit of MVP value). Oriented start=top → end=bottom.
   *
   * createdBy stores the Convex tokenIdentifier for now.
   * L1 (Better Auth) will add the `users` table; at that point createdBy
   * can be tightened to v.id("users") if lookup semantics are needed.
   */
  routes: defineTable({
    // — REQUIRED AT INPUT (minimal contributor effort) —
    name: v.string(),
    difficulty: v.union(
      v.literal('debutant'),
      v.literal('intermediaire'),
      v.literal('confirme'),
      v.literal('expert'),
    ),
    /** Departure pin — the HIGH point of the descent. */
    start: v.object({ lat: v.number(), lng: v.number() }),
    /** Arrival pin — the LOW point of the descent. */
    end: v.object({ lat: v.number(), lng: v.number() }),

    // — OPTIONAL AT INPUT, RICH AT DISPLAY —
    /** Ordered polyline start→end; absent ⇒ straight line on map. */
    path: v.optional(v.array(v.object({ lat: v.number(), lng: v.number() }))),
    /** Name of the descente (hill/spot) — light grouping of sibling routes (reco A). */
    spotName: v.optional(v.string()),
    surfaceQuality: v.optional(
      v.union(v.literal('lisse'), v.literal('correct'), v.literal('degrade')),
    ),
    slope: v.optional(
      v.union(v.literal('douce'), v.literal('moyenne'), v.literal('raide')),
    ),
    trafficLevel: v.optional(
      v.union(
        v.literal('aucun'),
        v.literal('faible'),
        v.literal('modere'),
        v.literal('eleve'),
      ),
    ),
    terrainType: v.optional(
      v.union(v.literal('rue'), v.literal('montagne'), v.literal('parking')),
    ),
    /** Multi-value: gravier, plaques d'égout, virages serrés… */
    hazards: v.optional(v.array(v.string())),
    description: v.optional(v.string()),

    // — SERVER-DERIVED (never entered by user) —
    /** Haversine over start → path… → end, metres. */
    lengthMeters: v.number(),
    /** D+ elevation (m) from routing SRTM — optional (unavailable when SRTM missing). */
    elevationGainMeters: v.optional(v.number()),
    /** D− elevation (m) from routing SRTM. */
    elevationDropMeters: v.optional(v.number()),
    /** Signed net grade % (negative = descent). */
    avgGradePct: v.optional(v.number()),
    /** Geohash of start at precision 6 (≈1.2 km cell) for bbox index. */
    geohash: v.string(),
    /** Convex tokenIdentifier of the creator (updated to v.id("users") in L1). */
    createdBy: v.string(),
    createdAt: v.number(),
  })
    .index('by_geohash', ['geohash'])
    .index('by_creator', ['createdBy', 'createdAt']),
})
