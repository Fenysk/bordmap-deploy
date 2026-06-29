/**
 * Re-stitch (splice) — pure, UI-free, isolated-testable (plan §3.3 FEN-987).
 * Replace path[idxA..idxB] with the recomputed sub-path, and splice the slope
 * profile in lockstep so pente max stays exact without re-routing (R1).
 */
import type { LatLng } from '../shared/geo'

/**
 * Replace original[idxA..idxB] (inclusive) with `subPath` (which starts at
 * original[idxA] and ends at original[idxB]); return the re-stitched full path.
 */
export function spliceSubPath(
  original: LatLng[],
  idxA: number,
  idxB: number,
  subPath: LatLng[],
): LatLng[] {
  return [...original.slice(0, idxA), ...subPath, ...original.slice(idxB + 1)]
}

/**
 * Splice the per-segment slope profile to match spliceSubPath. `orig` and `sub`
 * are segment arrays (length = points - 1); the result length tracks the new
 * full path's segment count.
 *
 * Segments [idxA..idxB-1] in `orig` (those internal to the replaced span) are
 * swapped out for `sub`; surrounding segments stay intact.
 */
export function spliceSlopeProfile(
  orig: number[],
  idxA: number,
  idxB: number,
  sub: number[],
): number[] {
  return [...orig.slice(0, idxA), ...sub, ...orig.slice(idxB)]
}
