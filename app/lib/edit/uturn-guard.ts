/**
 * Anti-U-turn guard — pure, UI-free, isolated-testable (FEN-1073 S1).
 * Detects when a proposed sub-path backtracks over the kept path flanks.
 * Conservative: prefers false-negative (letting a borderline case through)
 * over false-positive (refusing a legitimate reconnection).
 */
import type { LatLng } from '../shared/geo'
import { computeOverlapFraction } from '../shared/routing'

export const OVERLAP_TOL = 0.15
export const BACKTRACK_TOL_M = 40
/** Backtrack must also exceed this fraction of the global route axis to be a real U-turn.
 * FEN-1196 AC-3: only a manifestly absurd 180° reversal should be refused.
 * Alexis's case (reshape near the END, anchors co-located) must pass: the
 * new sub-path goes briefly backward before routing to the end, which is a
 * normal wide detour, NOT a U-turn. Raised from 0.33 to 0.80.
 */
export const BACKTRACK_RATIO = 0.80

const DEG_TO_RAD = Math.PI / 180
const EARTH_RADIUS_M = 6_371_008.8

/** Equirectangular x/y projection in metres, centred at refLat. */
function toXY(p: LatLng, refLat: number): { x: number; y: number } {
  const cosLat = Math.cos(refLat * DEG_TO_RAD)
  return {
    x: p.lng * cosLat * EARTH_RADIUS_M * DEG_TO_RAD,
    y: p.lat * EARTH_RADIUS_M * DEG_TO_RAD,
  }
}

export type UTurnReason = 'overlaps_kept' | 'reverses_progress'

export interface UTurnResult {
  isUTurn: boolean
  reason?: UTurnReason
}

/**
 * Detect if `newSubPath` creates a U-turn relative to the kept path flanks.
 *
 * @param newSubPath  The proposed replacement sub-path (anchorA..anchorB).
 * @param keptBefore  Path points up to and including anchorA.
 * @param keptAfter   Path points from anchorB onward.
 */
export function detectUTurn(
  newSubPath: LatLng[],
  keptBefore: LatLng[],
  keptAfter: LatLng[],
): UTurnResult {
  // (a) Overlap with kept segments
  if (computeOverlapFraction(newSubPath, [keptBefore, keptAfter], 30) > OVERLAP_TOL) {
    return { isUTurn: true, reason: 'overlaps_kept' }
  }

  // (b) Reverses progress along the GLOBAL route axis (routeStart→routeEnd).
  // Using the local anchorA→anchorB micro-segment as the axis caused false positives
  // when the two edit anchors were close together (~156 m): axLen×0.33≈51 m, so a
  // legitimate 78 m lateral detour was wrongly flagged (FEN-1156/FEN-1161).
  // The global route axis gives a denominator of several km, so only a genuine
  // reversal (> 33 % of the total route) is refused.
  if (newSubPath.length >= 2 && keptBefore.length >= 1 && keptAfter.length >= 1) {
    const routeStart = keptBefore[0]
    const routeEnd = keptAfter[keptAfter.length - 1]
    const refLat = (routeStart.lat + routeEnd.lat) / 2
    const a = toXY(routeStart, refLat)
    const b = toXY(routeEnd, refLat)
    const axDx = b.x - a.x
    const axDy = b.y - a.y
    const axLen = Math.sqrt(axDx * axDx + axDy * axDy)
    if (axLen > 1) {
      const ux = axDx / axLen
      const uy = axDy / axLen
      let backtrackM = 0
      for (let i = 0; i < newSubPath.length - 1; i++) {
        const p1 = toXY(newSubPath[i], refLat)
        const p2 = toXY(newSubPath[i + 1], refLat)
        const dot = (p2.x - p1.x) * ux + (p2.y - p1.y) * uy
        if (dot < 0) backtrackM += -dot
      }
      if (backtrackM > BACKTRACK_TOL_M && backtrackM > axLen * BACKTRACK_RATIO) {
        return { isUTurn: true, reason: 'reverses_progress' }
      }
    }
  }

  return { isUTurn: false }
}
