import { defineSchema, defineTable } from 'convex/server'
import { v } from 'convex/values'

const latLng = v.object({ lat: v.number(), lng: v.number() })

export default defineSchema({
  savedRoutes: defineTable({
    shareId: v.string(),
    start: latLng,
    end: latLng,
    path: v.array(latLng),
    distanceMeters: v.number(),
    createdAt: v.number(),
  }).index('by_share_id', ['shareId']),
})
