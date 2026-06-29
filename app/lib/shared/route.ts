import type { LatLng } from './geo'

export type { LatLng } from './geo'

// ─── Routing types (ADR 0002 / FEN-502) ─────────────────────────────────────

export interface RouteElevation {
  gainMeters: number
  dropMeters: number
  avgGradePct: number
}

// Plan §2.1 FEN-951 — stats produced by S2 backend, consumed by S4 UI
export interface RouteStats {
  distanceMeters: number
  durationSeconds: number | null
  maxGradePct: number | null
  counterFlowCount: number | null
}

export interface RouteCandidate {
  path: Array<LatLng>
  lengthMeters: number
  elevation: RouteElevation | null
  isPrimary: boolean
  stats: RouteStats
  // Plan §3.1 FEN-989 — per-segment |slope %| derived from GH average_slope.
  // slopeProfile[k] = |slope| of segment path[k]->path[k+1]; length = path.length - 1.
  // maxGradePct === max(slopeProfile); carried so a splice can recompute pente max
  // EXACTLY (slice/stitch alongside path) without re-routing (R1).
  slopeProfile: number[]
}

export type RoutingError = 'NO_ROUTE' | 'POINT_OFF_NETWORK' | 'ROUTING_UNAVAILABLE'

export type ComputeRoutesResult =
  | { ok: true; candidates: Array<RouteCandidate> }
  | { ok: false; error: RoutingError; message: string }

// ─── Alternative routing types (plan §2 FEN-800) ─────────────────────────────

export type RouteHandle = {
  handle: string
  path: Array<LatLng>
}

export type AltRouteCandidate = {
  handle: string
  path: Array<LatLng>
  distanceMeters: number
  durationSeconds: number | null
  ascentMeters?: number
  overlapWithExcluded: number
  stats: RouteStats
  // Plan §3.1 FEN-989 — see RouteCandidate.slopeProfile. length = path.length - 1.
  slopeProfile: number[]
}

export type NextAlternativeResult =
  | { status: 'ok'; candidate: AltRouteCandidate }
  | { status: 'exhausted'; reason: 'no_distinct_corridor' | 'quality_floor' | 'max_alternatives_reached' }
  | { status: 'error'; code: string; message: string }

// ─── Local edit contract (plan §3.2 FEN-987 / Stream 0 FEN-989) ──────────────
// FE↔backend thin wrapper for the LOCAL segment edit. Only the sub-path between
// two on-road anchors recomputes; the rest of the route is frozen then re-stitched.

export interface EditSegmentRequest {
  mode: 'redirect' | 'avoid' // C | B
  anchorA: LatLng // = path[i] of the original (already snapped on-road)
  anchorB: LatLng // = path[j] of the original
  via?: LatLng // mode 'redirect' only: dragged/tapped target
  rejectedSubPath?: LatLng[] // mode 'avoid' only: path[i..j] to avoid
}

export interface EditedSubPath {
  subPath: LatLng[] // starts at anchorA, ends at anchorB (snapped by GH)
  slopeProfile: number[] // length = subPath.length - 1
  stats: RouteStats // stats of the SUB-path (new bit's distance/slope)
}

// Honesty #2/#16/#6 — kept distinct from a retryable engine error.
export type EditSegmentError =
  | 'NO_LOCAL_ROUTE' // avoid: no practicable detour left between anchors (#2, honest empty, NOT retryable)
  | 'POINT_OFF_NETWORK' // redirect: target off-network -> reposition (#6)
  | 'ROUTING_UNAVAILABLE' // engine unreachable / 5xx (#16, RETRYABLE)

export type EditSegmentResult =
  | { ok: true; edit: EditedSubPath }
  | { ok: false; error: EditSegmentError; message: string }

// ─────────────────────────────────────────────────────────────────────────────

export type GeoJsonLineString = {
  type: 'LineString'
  coordinates: Array<[number, number]>
}

type WithGeometry = { start: LatLng; end: LatLng; path?: Array<LatLng> }

export function routePoints(route: WithGeometry): Array<LatLng> {
  return [route.start, ...(route.path ?? []), route.end]
}

export function toLineString(route: WithGeometry): GeoJsonLineString {
  return {
    type: 'LineString',
    coordinates: routePoints(route).map(({ lat, lng }) => [lng, lat]),
  }
}
