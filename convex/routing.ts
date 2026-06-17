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
    // GraphHopper runs as a SEPARATE Coolify resource on the shared `coolify`
    // network. Cross-resource name resolution there is fragile (FEN-518): the
    // container_name, the resource UUID, and the env value have all been seen as
    // the "right" host depending on Coolify's network-alias behaviour. Rather
    // than bet on one, try each known internal address in order and use the first
    // that answers. The env value (Convex env store, set by app-entrypoint) wins
    // when present; the UUID alias is GraphHopper's Coolify app uuid.
    const hosts = [
      process.env.GRAPHHOPPER_URL,
      'http://bordmap-graphhopper:8989',
      'http://hd16llwd4rwxpsxplzieci24:8989',
    ].filter((v, i, a): v is string => Boolean(v) && a.indexOf(v) === i)

    const params = new URLSearchParams()
    params.append('point', `${start.lat},${start.lng}`)
    if (via) params.append('point', `${via.lat},${via.lng}`)
    params.append('point', `${end.lat},${end.lng}`)
    params.append('profile', 'bordmap_road')
    // FEN-603 (CEO anti-loop steer 2026-06-17): NO alternative_route. It requires LM
    // preprocessing, which keeps OOM-ing/timing-out the build and took GraphHopper
    // down (board: "graphhopper:8989 connection refused"). LM is disabled in
    // config.yml (profiles_lm: []) to keep GH UP and stable, so requesting the
    // alternative_route algorithm here would make GH 400 every route. Base routing
    // returns a single on-road itinerary — the core of Alexis's ask. Alternative
    // itineraries are a memory-gated FOLLOW-UP: re-enable config.yml `profiles_lm`
    // AND this block together once there is import RAM headroom.
    params.append('elevation', 'true')
    params.append('points_encoded', 'false')
    params.append('instructions', 'false')
    params.append('calc_points', 'true')

    const query = `/route?${params.toString()}`
    let resp: Response | undefined
    const errors: string[] = []
    for (const base of hosts) {
      try {
        const ctrl = new AbortController()
        const timeout = setTimeout(() => ctrl.abort(), 10_000)
        resp = await fetch(`${base}${query}`, { signal: ctrl.signal })
        clearTimeout(timeout)
        break
      } catch (err: unknown) {
        const m = err instanceof Error ? `${err.constructor.name}:${err.message}` : String(err)
        errors.push(`${base}=>${m}`)
      }
    }
    if (!resp) {
      // All candidates unreachable — report each host's failure (untruncated) so
      // we can tell DNS failure from connection refused without container exec.
      return { ok: false, error: 'ROUTING_UNAVAILABLE', message: `FETCH_ERR_ALL ${errors.join(' || ').slice(0, 400)}` }
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
      return { ok: false, error: 'ROUTING_UNAVAILABLE', message: 'Aucun itinéraire — repositionnez D ou A.' }
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
