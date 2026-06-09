/**
 * Tests for the route contract helpers and server-derived field logic.
 * These are the same computations that convex/routes.ts#create runs
 * server-side — tested here in pure TS (no Convex runtime needed).
 */
import { describe, it, expect } from 'vitest'
import { routePoints, toLineString } from './route'
import { pathLengthMeters, geohashOf } from './geo'

const start = { lat: 45.196, lng: 5.728 } // Grenoble upper
const end = { lat: 45.183, lng: 5.722 } // Grenoble lower
const mid = { lat: 45.19, lng: 5.725 }

describe('routePoints', () => {
  it('returns [start, end] when no path', () => {
    expect(routePoints({ start, end })).toEqual([start, end])
  })

  it('includes path waypoints in order', () => {
    expect(routePoints({ start, end, path: [mid] })).toEqual([start, mid, end])
  })
})

describe('server-derived lengthMeters', () => {
  it('is positive for a real start→end pair', () => {
    const pts = routePoints({ start, end })
    expect(pathLengthMeters(pts)).toBeGreaterThan(0)
  })

  it('is longer when a detour waypoint is added', () => {
    const direct = pathLengthMeters(routePoints({ start, end }))
    const withMid = pathLengthMeters(routePoints({ start, end, path: [mid] }))
    // Triangle inequality: start→mid→end ≥ start→end
    expect(withMid).toBeGreaterThanOrEqual(direct)
  })

  it('Grenoble ~1.7 km direct', () => {
    const m = pathLengthMeters(routePoints({ start, end }))
    expect(m).toBeGreaterThan(1_400)
    expect(m).toBeLessThan(2_000)
  })
})

describe('server-derived geohash', () => {
  it('is 6 chars at default precision', () => {
    expect(geohashOf(start)).toHaveLength(6)
  })

  it('is stable (same input → same hash)', () => {
    expect(geohashOf(start)).toBe(geohashOf(start))
  })

  it('geohash of start and nearby end share a prefix (same ~1.2 km cell or adjacent)', () => {
    // start and end are ~1.7 km apart; they may share precision-4 or 5 prefix
    const h1 = geohashOf(start)
    const h2 = geohashOf(end)
    expect(h1.slice(0, 3)).toBe(h2.slice(0, 3))
  })
})

describe('toLineString', () => {
  it('produces a valid GeoJSON LineString', () => {
    const ls = toLineString({ start, end, path: [mid] })
    expect(ls.type).toBe('LineString')
    expect(ls.coordinates).toHaveLength(3)
    // GeoJSON is [lng, lat]
    expect(ls.coordinates[0]).toEqual([start.lng, start.lat])
    expect(ls.coordinates[2]).toEqual([end.lng, end.lat])
  })
})
