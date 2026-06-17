/**
 * Geo helpers shared by frontend (map bounds, line length preview) and Convex
 * backend (server-side `lengthMeters` + `geohash` derivation in L2).
 *
 * Zero dependencies, pure functions, deterministic — safe to run in the Convex
 * runtime and in the browser. Unit-tested in `geo.test.ts`.
 */

export interface LatLng {
  lat: number
  lng: number
}

export interface BoundingBox {
  minLat: number
  minLng: number
  maxLat: number
  maxLng: number
}

const EARTH_RADIUS_M = 6_371_008.8 // mean Earth radius (IUGG)

const toRad = (deg: number): number => (deg * Math.PI) / 180

/**
 * Great-circle distance between two points in metres (haversine).
 * Accurate to well within a metre at the street/hill scale Bordmap cares about.
 */
export function haversineMeters(a: LatLng, b: LatLng): number {
  const dLat = toRad(b.lat - a.lat)
  const dLng = toRad(b.lng - a.lng)
  const lat1 = toRad(a.lat)
  const lat2 = toRad(b.lat)

  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)))
}

/**
 * Total length in metres of an ordered polyline. For a bare start→end route
 * (no `path`), pass `[start, end]`. Returns 0 for fewer than 2 points.
 */
export function pathLengthMeters(points: ReadonlyArray<LatLng>): number {
  let total = 0
  for (let i = 1; i < points.length; i++) {
    total += haversineMeters(points[i - 1], points[i])
  }
  return total
}

const GEOHASH_BASE32 = '0123456789bcdefghjkmnpqrstuvwxyz' // RFC-ish (no a,i,l,o)

/**
 * Encode a point to a geohash string. Default precision 6 ≈ 1.2 km cells,
 * the bucket size used for the bbox query index (`by_geohash`, plan §3).
 */
export function geohashEncode(lat: number, lng: number, precision = 6): string {
  if (lat < -90 || lat > 90) throw new RangeError(`lat out of range: ${lat}`)
  if (lng < -180 || lng > 180) throw new RangeError(`lng out of range: ${lng}`)

  let latMin = -90
  let latMax = 90
  let lngMin = -180
  let lngMax = 180

  let hash = ''
  let bit = 0
  let ch = 0
  let even = true // start with longitude

  while (hash.length < precision) {
    if (even) {
      const mid = (lngMin + lngMax) / 2
      if (lng >= mid) {
        ch = (ch << 1) | 1
        lngMin = mid
      } else {
        ch = ch << 1
        lngMax = mid
      }
    } else {
      const mid = (latMin + latMax) / 2
      if (lat >= mid) {
        ch = (ch << 1) | 1
        latMin = mid
      } else {
        ch = ch << 1
        latMax = mid
      }
    }
    even = !even

    if (++bit === 5) {
      hash += GEOHASH_BASE32[ch]
      bit = 0
      ch = 0
    }
  }
  return hash
}

/** Convenience overload taking a `LatLng`. */
export function geohashOf(point: LatLng, precision = 6): string {
  return geohashEncode(point.lat, point.lng, precision)
}
