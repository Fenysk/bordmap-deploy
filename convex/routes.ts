/**
 * L2 — Convex API for the `routes` table (plan §3 of FEN-341).
 *
 * Auth model: mutations are auth-gated via ctx.auth.getUserIdentity();
 * all queries are public (discovery without login). createdBy stores the
 * Convex tokenIdentifier; this is updated to v.id("users") lookup in L1.
 */
import { ConvexError, v } from 'convex/values'
import { mutation, query } from './_generated/server'
import { pathLengthMeters, geohashOf } from '../app/lib/shared/geo'

// Reusable validators — mirror the schema literals exactly.
const latLng = v.object({ lat: v.number(), lng: v.number() })

const difficulty = v.union(
  v.literal('debutant'),
  v.literal('intermediaire'),
  v.literal('confirme'),
  v.literal('expert'),
)

const richArgs = {
  path: v.optional(v.array(latLng)),
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
  hazards: v.optional(v.array(v.string())),
  description: v.optional(v.string()),
}

/**
 * Create a route. Auth-gated. Server derives lengthMeters, geohash,
 * createdBy, createdAt. Elevation fields are accepted from the routing engine
 * (they cannot be derived from lat/lng alone) — all optional per ADR 0002.
 */
export const create = mutation({
  args: {
    name: v.string(),
    difficulty,
    start: latLng,
    end: latLng,
    // Elevation from routing engine (ADR 0002 schema delta)
    elevationGainMeters: v.optional(v.number()),
    elevationDropMeters: v.optional(v.number()),
    avgGradePct: v.optional(v.number()),
    ...richArgs,
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity()
    if (!identity) throw new ConvexError('Authentification requise')

    const points = [args.start, ...(args.path ?? []), args.end]
    const lengthMeters = pathLengthMeters(points)
    const geohash = geohashOf(args.start)

    return ctx.db.insert('routes', {
      name: args.name,
      difficulty: args.difficulty,
      start: args.start,
      end: args.end,
      path: args.path,
      spotName: args.spotName,
      surfaceQuality: args.surfaceQuality,
      slope: args.slope,
      trafficLevel: args.trafficLevel,
      terrainType: args.terrainType,
      hazards: args.hazards,
      description: args.description,
      lengthMeters,
      elevationGainMeters: args.elevationGainMeters,
      elevationDropMeters: args.elevationDropMeters,
      avgGradePct: args.avgGradePct,
      geohash,
      createdBy: identity.tokenIdentifier,
      createdAt: Date.now(),
    })
  },
})

/**
 * List routes whose start point is inside the given bounding box.
 * Public — no auth required.
 *
 * Strategy: full table scan at MVP scale (hundreds of routes).
 * The by_geohash index is wired for future optimisation (multi-cell
 * enumeration), but a full scan is simpler and correct at this volume.
 */
export const listInBounds = query({
  args: {
    minLat: v.number(),
    minLng: v.number(),
    maxLat: v.number(),
    maxLng: v.number(),
  },
  handler: async (ctx, { minLat, minLng, maxLat, maxLng }) => {
    const all = await ctx.db.query('routes').collect()
    return all.filter(
      (r) =>
        r.start.lat >= minLat &&
        r.start.lat <= maxLat &&
        r.start.lng >= minLng &&
        r.start.lng <= maxLng,
    )
  },
})

/**
 * Get a single route by ID (rich detail card). Public.
 */
export const get = query({
  args: { routeId: v.id('routes') },
  handler: async (ctx, { routeId }) => {
    return ctx.db.get(routeId)
  },
})

/**
 * List routes created by the authenticated user, newest first.
 * Returns null when Convex auth is not yet established (JWT pending or expired)
 * so useQuery can treat it as a transient loading state instead of crashing the
 * React tree via the error boundary. The route guard (beforeLoad) already
 * prevents unauthenticated HTTP access; null here is a client-timing safeguard.
 */
export const listMine = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity()
    if (!identity) return null

    return ctx.db
      .query('routes')
      .withIndex('by_creator', (q) => q.eq('createdBy', identity.tokenIdentifier))
      .order('desc')
      .collect()
  },
})
