/**
 * Pure routing helpers for computeNextAlternative (plan §2–§3, FEN-800).
 * No Convex runtime dependency — safe to import in tests and frontend code.
 */
import type { LatLng } from './geo'
import { haversineMeters } from './geo'
import type { RouteHandle } from './route'

// ─── Handle ──────────────────────────────────────────────────────────────────

const COORD_PRECISION = 5 // ~1 m at equator

/** Deterministic opaque handle for a snapped path — FNV-1a 32-bit over rounded coords. */
export function computeHandle(path: LatLng[]): string {
  const s = path
    .map(p => `${p.lat.toFixed(COORD_PRECISION)},${p.lng.toFixed(COORD_PRECISION)}`)
    .join('|')
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

// ─── Path simplification ─────────────────────────────────────────────────────

/**
 * Cap how many waypoints per route are used when building exclusion corridors.
 * A full snapped route can have 200–500+ points → polygon bloat → GH OOM (FEN-963).
 * 50 points gives a geometrically accurate corridor while capping each polygon
 * at ~100 vertices (left + right sides).
 */
export const MAX_CORRIDOR_WAYPOINTS = 50

/**
 * Uniform index-based downsampling: return at most maxPoints waypoints that
 * span the full path from first to last point.
 */
export function simplifyPath(path: LatLng[], maxPoints: number): LatLng[] {
  if (path.length <= maxPoints) return path
  const result: LatLng[] = []
  for (let i = 0; i < maxPoints; i++) {
    result.push(path[Math.round((i * (path.length - 1)) / (maxPoints - 1))])
  }
  return result
}

// ─── Exclusion area builder ───────────────────────────────────────────────────

function metersToDegreesLat(m: number): number {
  return m / 111_320
}

function metersToDegreesLng(m: number, latDeg: number): number {
  const cosLat = Math.cos((latDeg * Math.PI) / 180)
  return cosLat > 1e-10 ? m / (111_320 * cosLat) : m / 111_320
}

/**
 * Build a GeoJSON Polygon ring (array of [lng, lat] pairs, closed) that forms
 * a ~bufferMeters-wide corridor around the polyline.
 * Returns [] for paths shorter than 2 points.
 */
export function buildCorridorRing(path: LatLng[], bufferMeters: number): number[][] {
  if (path.length < 2) return []

  const left: number[][] = []
  const right: number[][] = []

  for (let i = 0; i < path.length - 1; i++) {
    const p1 = path[i]
    const p2 = path[i + 1]
    const midLat = (p1.lat + p2.lat) / 2

    const dlat = p2.lat - p1.lat
    const dlng = p2.lng - p1.lng
    const lenDeg = Math.sqrt(dlat * dlat + dlng * dlng)
    if (lenDeg === 0) continue

    // Unit perpendicular vector (90° CCW)
    const perpLat = -dlng / lenDeg
    const perpLng = dlat / lenDeg

    const bLat = metersToDegreesLat(bufferMeters)
    const bLng = metersToDegreesLng(bufferMeters, midLat)

    if (i === 0) {
      left.push([p1.lng + perpLng * bLng, p1.lat + perpLat * bLat])
      right.push([p1.lng - perpLng * bLng, p1.lat - perpLat * bLat])
    }
    left.push([p2.lng + perpLng * bLng, p2.lat + perpLat * bLat])
    right.push([p2.lng - perpLng * bLng, p2.lat - perpLat * bLat])
  }

  if (left.length < 2) return []

  // Corridor ring: left side forward + right side reversed + close
  return [...left, ...right.reverse(), left[0]]
}

type GeoFeatureCollection = {
  type: 'FeatureCollection'
  features: Array<{
    type: 'Feature'
    id: string
    geometry: { type: 'Polygon'; coordinates: number[][][] }
  }>
}

/**
 * Build the GraphHopper custom_model `areas` FeatureCollection.
 * One avoid_N polygon per excluded route (plan §1 — area avoidance).
 *
 * Paths are downsampled to MAX_CORRIDOR_WAYPOINTS before corridor building
 * to cap polygon vertex count and prevent GH OOM on long routes (FEN-963).
 */
export function buildExclusionAreas(
  excludes: RouteHandle[],
  bufferMeters = 45,
): GeoFeatureCollection {
  return {
    type: 'FeatureCollection',
    features: excludes
      .map((ex, i) => {
        const simplified = simplifyPath(ex.path, MAX_CORRIDOR_WAYPOINTS)
        const ring = buildCorridorRing(simplified, bufferMeters)
        if (ring.length < 4) return null
        return {
          type: 'Feature' as const,
          id: `avoid_${i}`,
          geometry: { type: 'Polygon' as const, coordinates: [ring] },
        }
      })
      .filter((f): f is NonNullable<typeof f> => f !== null),
  }
}

// ─── Overlap computation ──────────────────────────────────────────────────────

/** Minimum distance from point p to segment a→b, in metres. */
function pointToSegmentMeters(p: LatLng, a: LatLng, b: LatLng): number {
  const dlat = b.lat - a.lat
  const dlng = b.lng - a.lng
  const lenSq = dlat * dlat + dlng * dlng
  if (lenSq === 0) return haversineMeters(p, a)
  const t = Math.max(
    0,
    Math.min(1, ((p.lat - a.lat) * dlat + (p.lng - a.lng) * dlng) / lenSq),
  )
  return haversineMeters(p, { lat: a.lat + t * dlat, lng: a.lng + t * dlng })
}

/**
 * Fraction (0..1) of the candidate path (by arc-length) that lies within
 * thresholdMeters of any excluded path. Used for distinctness check (plan §3).
 */
export function computeOverlapFraction(
  candidatePath: LatLng[],
  excludedPaths: LatLng[][],
  thresholdMeters = 30,
): number {
  if (candidatePath.length < 2 || excludedPaths.length === 0) return 0

  let totalLen = 0
  let overlapLen = 0

  for (let i = 0; i < candidatePath.length - 1; i++) {
    const p1 = candidatePath[i]
    const p2 = candidatePath[i + 1]
    const segLen = haversineMeters(p1, p2)
    totalLen += segLen

    const mid: LatLng = { lat: (p1.lat + p2.lat) / 2, lng: (p1.lng + p2.lng) / 2 }

    let isNear = false
    outer: for (const excPath of excludedPaths) {
      for (let j = 0; j < excPath.length - 1; j++) {
        if (pointToSegmentMeters(mid, excPath[j], excPath[j + 1]) <= thresholdMeters) {
          isNear = true
          break outer
        }
      }
      // Also check last point as a degenerate segment
      if (excPath.length === 1 && haversineMeters(mid, excPath[0]) <= thresholdMeters) {
        isNear = true
        break
      }
    }

    if (isNear) overlapLen += segLen
  }

  return totalLen > 0 ? overlapLen / totalLen : 0
}

// ─── Quality floor filters (plan §3) ─────────────────────────────────────────

export const MAX_OVERLAP = 0.70
export const MAX_DIST_FACTOR = 1.6
export const MAX_DUR_FACTOR = 1.8

export function passesDistinctnessCheck(overlap: number): boolean {
  return overlap <= MAX_OVERLAP
}

export function passesQualityFloor(
  distMeters: number,
  durSec: number,
  primaryDistMeters: number,
  primaryDurSec: number,
): { passes: boolean; reason?: 'quality_floor' } {
  if (distMeters > MAX_DIST_FACTOR * primaryDistMeters) return { passes: false, reason: 'quality_floor' }
  if (primaryDurSec > 0 && durSec > MAX_DUR_FACTOR * primaryDurSec)
    return { passes: false, reason: 'quality_floor' }
  return { passes: true }
}
