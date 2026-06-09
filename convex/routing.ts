/**
 * R2 routing action — calls GraphHopper internally, normalises to RouteCandidate[].
 * Contract: ADR 0002 (FEN-502). Never falls back to straight line (CA-1.3).
 *
 * Call path: RouteMap → useAction(api.routing.computeRoutes) → GraphHopper.
 * GRAPHHOPPER_URL env var = internal Coolify service URL (never public).
 */
import { action } from './_generated/server'
import { v } from 'convex/values'
import type { ComputeRoutesResult } from '../app/lib/shared/route'

const latLng = v.object({ lat: v.number(), lng: v.number() })

export const computeRoutes = action({
  args: {
    start: latLng,
    end: latLng,
    via: v.optional(latLng),
  },
  handler: async (_ctx, { start, end, via }): Promise<ComputeRoutesResult> => {
    // Prefer the Convex env store (set by app-entrypoint.sh on each deploy).
    // Fall back to the canonical internal Coolify network hostname so routing
    // survives a bootstrap where convex env set could not run (e.g. no admin key).
    const base = process.env.GRAPHHOPPER_URL ?? 'http://bordmap-graphhopper:8989'

    const params = new URLSearchParams()
    params.append('point', `${start.lat},${start.lng}`)
    if (via) params.append('point', `${via.lat},${via.lng}`)
    params.append('point', `${end.lat},${end.lng}`)
    params.append('profile', 'bordmap_road')
    // FEN-518 note: alternative_route requires LM preprocessing (profiles_lm in
    // config.yml). Disabled for now — will re-enable once LM is confirmed in cache.
    // if (!via) {
    //   params.append('algorithm', 'alternative_route')
    //   params.append('alternative_route.max_paths', '3')
    // }
    params.append('elevation', 'true')
    params.append('points_encoded', 'false')
    params.append('instructions', 'false')
    params.append('calc_points', 'true')

    let resp: Response
    try {
      const ctrl = new AbortController()
      const timeout = setTimeout(() => ctrl.abort(), 10_000)
      resp = await fetch(`${base}/route?${params.toString()}`, { signal: ctrl.signal })
      clearTimeout(timeout)
    } catch (err: unknown) {
      const m = err instanceof Error ? `${err.constructor.name}:${err.message}` : String(err)
      return { ok: false, error: 'ROUTING_UNAVAILABLE', message: `FETCH_ERR ${m.slice(0, 100)} BASE:${base}` }
    }

    if (!resp.ok) {
      let body: { message?: string } = {}
      try { body = await resp.json() as typeof body } catch { /* ignore */ }
      const msg = body?.message ?? ''
      if (msg.includes('Connection between locations not found')) {
        return { ok: false, error: 'NO_ROUTE', message: 'Aucun itinéraire — repositionnez D ou A.' }
      }
      if (msg.includes('Cannot find point')) {
        return { ok: false, error: 'POINT_OFF_NETWORK', message: "Ce point n'est pas sur une route — déplacez-le." }
      }
      return { ok: false, error: 'ROUTING_UNAVAILABLE', message: `GH_HTTP_${resp.status}` }
    }

    type GhPath = {
      distance: number
      points: { coordinates: Array<[number, number, number?]> }
      ascend?: number
      descend?: number
    }
    const data = await resp.json() as { paths?: GhPath[] }

    if (!data.paths || data.paths.length === 0) {
      return { ok: false, error: 'NO_ROUTE', message: 'Aucun itinéraire — repositionnez D ou A.' }
    }

    const candidates = data.paths.map((p, i) => {
      const path = p.points.coordinates.map(([lng, lat]) => ({ lat, lng }))
      const hasElevation = p.ascend != null && p.descend != null
      const elevation = hasElevation
        ? {
            gainMeters: Math.round(p.ascend!),
            dropMeters: Math.round(p.descend!),
            avgGradePct:
              p.distance > 0
                ? Math.round(((p.ascend! - p.descend!) / p.distance) * 100 * 10) / 10
                : 0,
          }
        : null
      return {
        path,
        lengthMeters: Math.round(p.distance),
        elevation,
        isPrimary: i === 0,
      }
    })

    return { ok: true, candidates }
  },
})
