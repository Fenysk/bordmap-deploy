/**
 * The shared "route" contract (plan §2 of FEN-341).
 *
 * A **descente** is a hill that can host several lines; a **route** is one
 * rideable line, oriented `start` = top (higher altitude) → `end` = bottom.
 * This is the unit of value of the MVP. The asymmetry the board asked for —
 * minimal input vs rich display — is encoded as `RouteInput` (what a user
 * types) vs `Route` (what gets stored/shown, with server-derived fields).
 *
 * These types are intentionally framework-agnostic. L2 mirrors them as Convex
 * validators in `convex/schema.ts`; this file stays the single TS source of
 * truth the frontend imports.
 */
import type { LatLng } from './geo'
import type {
  Difficulty,
  SurfaceQuality,
  Slope,
  TrafficLevel,
  TerrainType,
} from './enums'

export type { LatLng } from './geo'

/** Rich (optional) attributes — entered optionally, displayed fully. */
export interface RouteRichFields {
  /** Optional drawn polyline (ordered start→end). Absent ⇒ straight start→end. */
  path?: Array<LatLng>
  /** Name of the *descente* — groups several routes on the same hill (reco A). */
  spotName?: string
  surfaceQuality?: SurfaceQuality
  slope?: Slope
  trafficLevel?: TrafficLevel
  terrainType?: TerrainType
  /** Multi-select free-ish hazards: gravier, plaques d'égout, virages serrés… */
  hazards?: Array<string>
  description?: string
}

/**
 * Minimal payload required to reference a route — exactly the 3 things a
 * contributor must provide: `name`, `difficulty`, and the geometry
 * (`start` = top, `end` = bottom). Everything else is optional.
 */
export interface RouteInput extends RouteRichFields {
  name: string
  difficulty: Difficulty
  /** Departure pin — the HIGH point of the descente. */
  start: LatLng
  /** Arrival pin — the LOW point. */
  end: LatLng
}

/**
 * Stored / displayed route. Extends the input with server-derived fields that
 * are never typed by the user (that's what powers the rich display).
 */
export interface Route extends RouteInput {
  _id: string
  /** Haversine over start→(path)→end, computed server-side. */
  lengthMeters: number
  /** D+ elevation (m) — from routing engine SRTM, null when unavailable. */
  elevationGainMeters?: number
  /** D− elevation (m) — from routing engine SRTM, null when unavailable. */
  elevationDropMeters?: number
  /** Signed net grade % (negative = descent). */
  avgGradePct?: number
  /** Geohash bucket for the bbox index. */
  geohash: string
  createdBy: string
  createdAt: number
}

// ─── Routing types (ADR 0002 / FEN-502) ─────────────────────────────────────

export interface RouteElevation {
  gainMeters: number
  dropMeters: number
  avgGradePct: number
}

export interface RouteCandidate {
  path: Array<LatLng>
  lengthMeters: number
  elevation: RouteElevation | null
  isPrimary: boolean
}

export type RoutingError = 'NO_ROUTE' | 'POINT_OFF_NETWORK' | 'ROUTING_UNAVAILABLE'

export type ComputeRoutesResult =
  | { ok: true; candidates: Array<RouteCandidate> }
  | { ok: false; error: RoutingError; message: string }

// ─────────────────────────────────────────────────────────────────────────────

/** GeoJSON `LineString` coordinates are [lng, lat] — note the order. */
export type GeoJsonLineString = {
  type: 'LineString'
  coordinates: Array<[number, number]>
}

/** Ordered points of a route: start → path… → end (no duplicates). */
export function routePoints(route: Pick<RouteInput, 'start' | 'end' | 'path'>): Array<LatLng> {
  return [route.start, ...(route.path ?? []), route.end]
}

/** Exchange format for geometry (sens départ→arrivée), per plan §2. */
export function toLineString(
  route: Pick<RouteInput, 'start' | 'end' | 'path'>,
): GeoJsonLineString {
  return {
    type: 'LineString',
    coordinates: routePoints(route).map(({ lat, lng }) => [lng, lat]),
  }
}
