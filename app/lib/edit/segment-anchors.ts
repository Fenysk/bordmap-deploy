/**
 * Segment selection & anchors — pure FE geometry (plan §3.3 FEN-987).
 * Tap a segment of the current path -> its two endpoints become
 * on-road anchors; the sub-path between them is the editable window.
 */
import type { LatLng } from '../shared/geo'
import { haversineMeters } from '../shared/geo'

export interface AnchorSelection {
  idxA: number // bounds in the current path (idxA < idxB)
  idxB: number
  anchorA: LatLng // = path[idxA]
  anchorB: LatLng // = path[idxB]
  rejectedSubPath: LatLng[] // = path.slice(idxA, idxB + 1)
}

const DEG_TO_RAD = Math.PI / 180
const EARTH_RADIUS_M = 6_371_008.8

/**
 * Equirectangular x/y projection in metres, centred at refLat.
 * Accurate to < 0.1 % at the street scale Bordmap works at.
 */
function toXY(p: LatLng, refLat: number): { x: number; y: number } {
  const cosLat = Math.cos(refLat * DEG_TO_RAD)
  return {
    x: p.lng * cosLat * EARTH_RADIUS_M * DEG_TO_RAD,
    y: p.lat * EARTH_RADIUS_M * DEG_TO_RAD,
  }
}

/**
 * Project P onto segment A→B.
 * Returns the clamped parameter t ∈ [0,1] and the haversine distance (m)
 * from P to the closest point on the segment.
 */
function projectOnSegment(
  A: LatLng,
  B: LatLng,
  P: LatLng,
): { t: number; distM: number } {
  const refLat = (A.lat + B.lat) / 2
  const a = toXY(A, refLat)
  const b = toXY(B, refLat)
  const p = toXY(P, refLat)
  const dx = b.x - a.x
  const dy = b.y - a.y
  const len2 = dx * dx + dy * dy
  const t =
    len2 === 0
      ? 0
      : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2))
  // Interpolate closest point in lat/lng (accurate enough for < 5 km segments)
  const closest: LatLng = {
    lat: A.lat + t * (B.lat - A.lat),
    lng: A.lng + t * (B.lng - A.lng),
  }
  return { t, distM: haversineMeters(closest, P) }
}

// Generous mobile touch tolerance (AC-TACTILE): ~75 m at street zoom.
const MAX_TAP_DIST_M = 75

/**
 * Find the anchor window around `tap`: walk the path for the nearest segment to
 * the tapped point, then expand by `halfWindowM` metres on each side to the
 * nearest path vertices. Returns null if the tap is too far from the line.
 * halfWindowM = half-window of the "portion" around the tap (UX param, §6/R2).
 */
export function findAnchorWindow(
  path: LatLng[],
  tap: LatLng,
  halfWindowM: number,
): AnchorSelection | null {
  if (path.length < 2) return null

  // 1. Find the nearest segment (and parameter t within it)
  let bestSeg = 0
  let bestT = 0
  let bestDist = Infinity

  for (let i = 0; i < path.length - 1; i++) {
    const { t, distM } = projectOnSegment(path[i], path[i + 1], tap)
    if (distM < bestDist) {
      bestDist = distM
      bestSeg = i
      bestT = t
    }
  }

  if (bestDist > MAX_TAP_DIST_M) return null

  const segLen = haversineMeters(path[bestSeg], path[bestSeg + 1])

  // 2. Walk backward from the tap projection to find idxA
  //    (accumulate until we have at least halfWindowM behind us)
  let backDist = bestT * segLen // distance from tap point back to path[bestSeg]
  let idxA = bestSeg
  while (idxA > 0 && backDist < halfWindowM) {
    backDist += haversineMeters(path[idxA - 1], path[idxA])
    idxA--
  }

  // 3. Walk forward from the tap projection to find idxB
  let fwdDist = (1 - bestT) * segLen // distance from tap point forward to path[bestSeg+1]
  let idxB = bestSeg + 1
  while (idxB < path.length - 1 && fwdDist < halfWindowM) {
    fwdDist += haversineMeters(path[idxB], path[idxB + 1])
    idxB++
  }

  return {
    idxA,
    idxB,
    anchorA: path[idxA],
    anchorB: path[idxB],
    rejectedSubPath: path.slice(idxA, idxB + 1),
  }
}
