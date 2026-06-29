import { v } from 'convex/values'
import { mutation, query } from './_generated/server'

const latLng = v.object({ lat: v.number(), lng: v.number() })

const BASE62 = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'
const SHARE_ID_LEN = 8

function randomBase62(len: number): string {
  let id = ''
  for (let i = 0; i < len; i++) {
    id += BASE62[Math.floor(Math.random() * BASE62.length)]
  }
  return id
}

/** Save a route and return its unique share ID (AC-5.1/R-F). */
export const save = mutation({
  args: {
    start: latLng,
    end: latLng,
    path: v.array(latLng),
    distanceMeters: v.number(),
  },
  handler: async (ctx, args) => {
    let shareId = randomBase62(SHARE_ID_LEN)
    for (let attempts = 0; attempts < 5; attempts++) {
      const existing = await ctx.db
        .query('savedRoutes')
        .withIndex('by_share_id', (q) => q.eq('shareId', shareId))
        .first()
      if (!existing) break
      shareId = randomBase62(SHARE_ID_LEN)
    }

    await ctx.db.insert('savedRoutes', {
      shareId,
      start: args.start,
      end: args.end,
      path: args.path,
      distanceMeters: args.distanceMeters,
      createdAt: Date.now(),
    })

    return { shareId }
  },
})

/** Retrieve a saved route by its share ID (AC-5.3). Returns null when not found. */
export const getByShareId = query({
  args: { shareId: v.string() },
  handler: async (ctx, { shareId }) => {
    return ctx.db
      .query('savedRoutes')
      .withIndex('by_share_id', (q) => q.eq('shareId', shareId))
      .first()
  },
})
