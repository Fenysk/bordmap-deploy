/**
 * Stats + slope honesty after an edit — pure (plan §3.3/§3.D FEN-987).
 * After a splice, recompute distance + pente max from the stitched path/profile
 * (honesty #2/#16/#6 — non-negotiable, R1), and map an EditSegmentError to a
 * user-facing FR message.
 */
import type { LatLng } from '../shared/geo'
import { pathLengthMeters } from '../shared/geo'
import type { EditSegmentError, RouteStats } from '../shared/route'

/**
 * Recompute route stats from the full stitched path and its slope profile.
 * maxGradePct = max(slopeProfile); distance = sum of segment lengths.
 */
export function recomputeStats(path: LatLng[], slopeProfile: number[]): RouteStats {
  return {
    distanceMeters: pathLengthMeters(path),
    durationSeconds: null,
    maxGradePct: slopeProfile.length > 0 ? Math.max(...slopeProfile) : null,
    counterFlowCount: null,
  }
}

/** Shown when detectUTurn rejects a proposed sub-path (4th honest state — AC-8). */
export const UTURN_REFUSED_MESSAGE =
  'Ce point crée un aller-retour — choisis un autre emplacement'

/** Map an EditSegmentError to its French user-facing message. */
export function editErrorMessage(error: EditSegmentError): string {
  switch (error) {
    case 'NO_LOCAL_ROUTE':
      // #2/#16: no practicable detour — NOT retryable, honest dead-end
      return "Plus d'itinéraire praticable sur cette portion — annule l'édition"
    case 'POINT_OFF_NETWORK':
      // #6: target off-network, user must reposition
      return "Ce point n'est pas sur une route — déplace-le"
    case 'ROUTING_UNAVAILABLE':
      // #16: transient engine failure — RETRYABLE
      return 'Routage momentanément indisponible — réessaie'
  }
}
