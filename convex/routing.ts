/**
 * R2 routing actions — call GraphHopper internally, expose on Convex.
 * Contract: ADR 0002 (FEN-502). Never falls back to straight line (CA-1.3).
 *
 * computeRoutes      — primary CH route (LM off, AC-B1)
 * computeNextAlternative — on-demand alternative via custom-model area avoidance
 *                          (no ch.disable — profiles_ch:[] makes GH flexible already,
 *                           FEN-826/FEN-807; plan §1–§3 FEN-800, AC-B1..B4)
 *
 * GRAPHHOPPER_URL env var = internal Coolify service URL (never public).
 */
import { action } from './_generated/server'
import { v } from 'convex/values'
import type { ComputeRoutesResult, NextAlternativeResult, AltRouteCandidate, EditSegmentResult } from '../app/lib/shared/route'
import type { RouteHandle } from '../app/lib/shared/route'
import {
  computeHandle,
  buildExclusionAreas,
  computeOverlapFraction,
  passesDistinctnessCheck,
  passesQualityFloor,
} from '../app/lib/shared/routing'
import { pathLengthMeters } from '../app/lib/shared/geo'

// ─── Stats helpers (FEN-953 AC-3) ────────────────────────────────────────────

type GhDetails = {
  average_slope?: Array<[number, number, number]>
  oneway?: Array<[number, number, boolean]>
}

/** Max absolute slope % across all detail segments; null when detail absent. */
function extractMaxGradePct(details?: GhDetails): number | null {
  const slopes = details?.average_slope
  if (!slopes?.length) return null
  let max = 0
  for (const [,, v] of slopes) {
    const abs = Math.abs(v)
    if (abs > max) max = abs
  }
  return Math.round(max * 10) / 10
}

/**
 * Per-segment |slope %| from GH average_slope detail (plan §3.1 FEN-989).
 * slopeProfile[k] = |slope| of edge path[k]→path[k+1]; length = pathLength - 1.
 * GH intervals: [fromIdx, toIdx, val] cover edges fromIdx..toIdx-1 inclusive.
 * Returns [] when detail absent or path too short.
 */
function extractSlopeProfile(details: GhDetails | undefined, pathLength: number): number[] {
  const slopeDetails = details?.average_slope
  const segCount = pathLength - 1
  if (!slopeDetails?.length || segCount <= 0) return []
  const profile = new Array<number>(segCount).fill(0)
  for (const [from, to, val] of slopeDetails) {
    const absVal = Math.round(Math.abs(val) * 10) / 10
    for (let k = from; k < to && k < segCount; k++) {
      profile[k] = absVal
    }
  }
  return profile
}

/** Count of oneway segments in the response; null when detail absent (S1 phase 2). */
function extractCounterFlowCount(details?: GhDetails): number | null {
  if (!details || !('oneway' in details)) return null
  return (details.oneway ?? []).filter(([,, v]) => v === true).length
}

const latLng = v.object({ lat: v.number(), lng: v.number() })

export const computeRoutes = action({
  args: {
    start: latLng,
    end: latLng,
    via: v.optional(latLng),
    vias: v.optional(v.array(latLng)),        // FEN-1202: ordered list; takes precedence over via
    avoidPath: v.optional(v.array(latLng)),   // FEN-1247: global zone avoidance (start→end)
  },
  handler: async (_ctx, { start, end, via, vias, avoidPath }): Promise<ComputeRoutesResult> => {
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

    const allVias = vias ?? (via ? [via] : [])
    let resp: Response | undefined
    const errors: string[] = []

    if (avoidPath?.length) {
      // FEN-1247: Global zone avoidance — POST with custom_model (flexible mode).
      // profiles_ch:[] already makes GH flexible; no ch.disable needed (FEN-826/807).
      // Single polygon (buffer 45 m) capped per FEN-963 anti-OOM rule.
      const areas = buildExclusionAreas(
        [{ handle: computeHandle(avoidPath), path: avoidPath }],
        45,
      )
      const postBody = {
        profile: 'bordmap_road',
        points: [
          [start.lng, start.lat],
          ...allVias.map(pt => [pt.lng, pt.lat]),
          [end.lng, end.lat],
        ],
        custom_model: {
          priority: [{ if: 'in_avoid_0', multiply_by: 0.05 }],
          areas,
        },
        points_encoded: false,
        elevation: true,
        details: ['average_slope'],
      }
      for (const base of hosts) {
        try {
          const ctrl = new AbortController()
          const timeout = setTimeout(() => ctrl.abort(), 15_000)
          resp = await fetch(`${base}/route`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(postBody),
            signal: ctrl.signal,
          })
          clearTimeout(timeout)
          break
        } catch (err: unknown) {
          const m = err instanceof Error ? `${err.constructor.name}:${err.message}` : String(err)
          errors.push(`${base}=>${m}`)
        }
      }
    } else {
      // Standard CH route — GET.
      // FEN-603 (CEO anti-loop steer 2026-06-17): NO alternative_route. It requires LM
      // preprocessing, which keeps OOM-ing/timing-out the build and took GraphHopper
      // down (board: "graphhopper:8989 connection refused"). LM is disabled in
      // config.yml (profiles_lm: []) to keep GH UP and stable, so requesting the
      // alternative_route algorithm here would make GH 400 every route. Base routing
      // returns a single on-road itinerary — the core of Alexis's ask. Alternative
      // itineraries are a memory-gated FOLLOW-UP: re-enable config.yml `profiles_lm`
      // AND this block together once there is import RAM headroom.
      const params = new URLSearchParams()
      params.append('point', `${start.lat},${start.lng}`)
      for (const pt of allVias) {
        params.append('point', `${pt.lat},${pt.lng}`)
      }
      params.append('point', `${end.lat},${end.lng}`)
      params.append('profile', 'bordmap_road')
      params.append('elevation', 'true')
      params.append('points_encoded', 'false')
      params.append('instructions', 'false')
      params.append('calc_points', 'true')
      params.append('details', 'average_slope')
      // NOTE (FEN-955): `oneway` is NOT an enabled encoded_value on the bordmap_road
      // graph (vehicle `roads` is direction-agnostic — config.yml graph.encoded_values
      // has no oneway), so requesting it 400s EVERY route: GH "Cannot find the path
      // details: [oneway]". The counter-flow stat is "S1 phase 2" and the stats helper
      // already returns null when the detail is absent — so drop it here until oneway
      // is actually encoded (would require a graph re-import). Re-add in lockstep.
      for (const base of hosts) {
        try {
          const ctrl = new AbortController()
          const timeout = setTimeout(() => ctrl.abort(), 10_000)
          resp = await fetch(`${base}/route?${params.toString()}`, { signal: ctrl.signal })
          clearTimeout(timeout)
          break
        } catch (err: unknown) {
          const m = err instanceof Error ? `${err.constructor.name}:${err.message}` : String(err)
          errors.push(`${base}=>${m}`)
        }
      }
    }

    if (!resp) {
      // All candidates unreachable — report each host's failure (untruncated) so
      // we can tell DNS failure from connection refused without container exec.
      return { ok: false, error: 'ROUTING_UNAVAILABLE', message: `FETCH_ERR_ALL ${errors.join(' || ').slice(0, 400)}` }
    }

    if (!resp.ok) {
      let errBody: { message?: string } = {}
      try { errBody = await resp.json() as typeof errBody } catch { /* ignore */ }
      const msg = errBody?.message ?? ''
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
      time: number
      points: { coordinates: Array<[number, number, number?]> }
      ascend?: number
      descend?: number
      details?: GhDetails
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
      const stats = {
        distanceMeters: Math.round(p.distance),
        durationSeconds: null, // GH roads vehicle uses car speed (~258 km/h) — not Freebord-reliable
        maxGradePct: extractMaxGradePct(p.details),
        counterFlowCount: extractCounterFlowCount(p.details),
      }
      return {
        path,
        lengthMeters: Math.round(p.distance),
        elevation,
        isPrimary: i === 0,
        stats,
        slopeProfile: extractSlopeProfile(p.details, path.length),
      }
    })

    return { ok: true, candidates }
  },
})

// ─── computeNextAlternative (FEN-800 plan §1–§3) ──────────────────────────────

const latLngValidator = v.object({ lat: v.number(), lng: v.number() })
const routeHandleValidator = v.object({
  handle: v.string(),
  path: v.array(latLngValidator),
})

/** K=3 attempts with increasing buffer pressure (plan §3 — cap documenté). */
const ATTEMPT_BUFFER_METERS = [45, 60, 80] as const

/**
 * Hard cap on cumulative exclusion routes to prevent GH OOM (FEN-963).
 * exclude[0] is always the primary route; each subsequent entry is an alternative.
 * At 4 entries (primary + 3 alts) any further call returns exhausted immediately
 * without hitting GH — no polygon bloat, no full-graph OOM.
 */
const MAX_EXCLUDE_ROUTES = 4

/**
 * On-demand alternative itinerary via GraphHopper flexible mode (profiles_ch:[]
 * already disables CH globally — no ch.disable flag needed, FEN-826/807)
 * + custom model area avoidance. No LM, no alternative_route algorithm — AC-G1.
 *
 * Returns:
 *   { status:"ok", candidate } when a distinct, quality-passing route is found.
 *   { status:"exhausted", reason } when K attempts all return 200 but no path
 *     passes distinctness/quality — AC-B3, AC-5, never throws.
 *   { status:"error", code, message } for GH unreachable / 4xx-5xx / timeout
 *     (AC-4, cas #16 — retryable by the caller).
 */
export const computeNextAlternative = action({
  args: {
    start: latLngValidator,
    end: latLngValidator,
    exclude: v.array(routeHandleValidator),
  },
  handler: async (_ctx, { start, end, exclude }): Promise<NextAlternativeResult> => {
    if (exclude.length === 0) {
      return { status: 'error', code: 'INVALID_ARGS', message: 'exclude must contain at least the primary route' }
    }

    // FEN-963: hard cap — once the user already has MAX_EXCLUDE_ROUTES-1 alternatives
    // any further call would send MAX_EXCLUDE_ROUTES polygons to GH in flexible mode,
    // each potentially 200–500-vertex corridors → cumulative OOM. Return exhausted
    // deterministically; no GH call, no memory pressure.
    if (exclude.length >= MAX_EXCLUDE_ROUTES) {
      return { status: 'exhausted', reason: 'max_alternatives_reached' }
    }

    const hosts = [
      process.env.GRAPHHOPPER_URL,
      'http://bordmap-graphhopper:8989',
      'http://hd16llwd4rwxpsxplzieci24:8989',
    ].filter((v, i, a): v is string => Boolean(v) && a.indexOf(v) === i)

    // ── Primary route metrics for quality floor ─────────────────────────────
    // Re-query via fast CH (no exclusions) to get reference dist + duration.
    // Fallback to path-length estimate if GH unreachable.
    let primaryDistMeters = 0
    let primaryDurSec = 0
    {
      const params = new URLSearchParams()
      params.append('point', `${start.lat},${start.lng}`)
      params.append('point', `${end.lat},${end.lng}`)
      params.append('profile', 'bordmap_road')
      params.append('points_encoded', 'false')
      params.append('elevation', 'false')
      params.append('instructions', 'false')
      params.append('calc_points', 'false')

      let resp: Response | undefined
      for (const base of hosts) {
        try {
          const ctrl = new AbortController()
          const timeout = setTimeout(() => ctrl.abort(), 8_000)
          resp = await fetch(`${base}/route?${params.toString()}`, { signal: ctrl.signal })
          clearTimeout(timeout)
          break
        } catch { /* try next host */ }
      }
      if (resp?.ok) {
        const data = await resp.json() as { paths?: Array<{ distance: number; time: number }> }
        if (data.paths?.[0]) {
          primaryDistMeters = Math.round(data.paths[0].distance)
          primaryDurSec = Math.round(data.paths[0].time / 1000)
        }
      }
      // Fallback: derive from the exclude[0] path geometry (already snapped by GH)
      if (primaryDistMeters === 0) {
        primaryDistMeters = Math.round(pathLengthMeters(exclude[0].path))
        // No reliable duration estimate without GH; leave at 0 (duration check skipped)
      }
    }

    // ── K=3 flexible attempts with increasing buffer pressure ──────────────
    type GhPath = {
      distance: number
      time: number
      points: { coordinates: Array<[number, number, number?]> }
      ascend?: number
      details?: GhDetails
    }

    let lastFailReason: 'no_distinct_corridor' | 'quality_floor' = 'no_distinct_corridor'

    for (let attempt = 0; attempt < ATTEMPT_BUFFER_METERS.length; attempt++) {
      const bufferMeters = ATTEMPT_BUFFER_METERS[attempt]
      const areas = buildExclusionAreas(exclude as RouteHandle[], bufferMeters)

      const body = {
        profile: 'bordmap_road',
        points: [
          [start.lng, start.lat],
          [end.lng, end.lat],
        ],
        custom_model: {
          priority: exclude.map((_, i) => ({ if: `in_avoid_${i}`, multiply_by: 0.05 })),
          areas,
        },
        points_encoded: false,
        elevation: true,
        // FEN-955: drop 'oneway' — not an enabled encoded_value (see computeRoutes note).
        details: ['average_slope'],
      }

      let resp: Response | undefined
      for (const base of hosts) {
        try {
          const ctrl = new AbortController()
          const timeout = setTimeout(() => ctrl.abort(), 15_000)
          resp = await fetch(`${base}/route`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal: ctrl.signal,
          })
          clearTimeout(timeout)
          break
        } catch { /* try next host */ }
      }

      // GH unreachable (network/timeout) → error, not exhausted (AC-4, cas #16)
      if (!resp) {
        return { status: 'error', code: 'ROUTING_UNAVAILABLE', message: 'GraphHopper unreachable' }
      }
      // GH returned non-200 → error, not exhausted
      if (!resp.ok) {
        let errBody: { message?: string } = {}
        try { errBody = await resp.json() as typeof errBody } catch { /* ignore */ }
        return { status: 'error', code: 'GH_HTTP_ERROR', message: errBody?.message ?? `HTTP ${resp.status}` }
      }

      const data = await resp.json() as { paths?: GhPath[] }
      if (!data.paths?.length) {
        lastFailReason = 'no_distinct_corridor'
        continue
      }

      const p = data.paths[0]
      const candidatePath = p.points.coordinates.map(([lng, lat]) => ({ lat, lng }))
      const distMeters = Math.round(p.distance)
      const durSec = Math.round(p.time / 1000)

      // Distinctness check (plan §3 — overlap ≤ 0.70)
      const overlap = computeOverlapFraction(
        candidatePath,
        exclude.map(ex => ex.path),
        30,
      )
      if (!passesDistinctnessCheck(overlap)) {
        lastFailReason = 'no_distinct_corridor'
        continue
      }

      // Quality floor (plan §3 — dist ≤ 1.6× + dur ≤ 1.8×)
      const qf = passesQualityFloor(distMeters, durSec, primaryDistMeters, primaryDurSec)
      if (!qf.passes) {
        lastFailReason = qf.reason ?? 'quality_floor'
        continue
      }

      // All checks passed — return the candidate with stats
      const altSlopeProfile = extractSlopeProfile(p.details, candidatePath.length)
      const candidate: AltRouteCandidate = {
        handle: computeHandle(candidatePath),
        path: candidatePath,
        distanceMeters: distMeters,
        durationSeconds: null, // GH roads vehicle uses car speed — not Freebord-reliable
        ascentMeters: p.ascend != null ? Math.round(p.ascend) : undefined,
        overlapWithExcluded: overlap,
        stats: {
          distanceMeters: distMeters,
          durationSeconds: null,
          maxGradePct: altSlopeProfile.length > 0 ? Math.max(0, ...altSlopeProfile) : extractMaxGradePct(p.details),
          counterFlowCount: extractCounterFlowCount(p.details),
        },
        slopeProfile: altSlopeProfile,
      }
      return { status: 'ok', candidate }
    }

    // All K attempts exhausted — graceful signal AC-B3
    return { status: 'exhausted', reason: lastFailReason }
  },
})

// ─── editSegment (FEN-987 §3.2 / FEN-992 Stream C) ───────────────────────────
// Recomputes ONLY the sub-path between two on-road anchors.
//   redirect (C): route anchorA → via → anchorB; POINT_OFF_NETWORK when via is off-net.
//   avoid   (B): scoped exclusion polygon on rejectedSubPath (reuses FEN-963 brick);
//                distinctness/quality relative to sub-path length (R3);
//                NO_LOCAL_ROUTE when no practicable detour exists (non-retryable).
// Guard R7: no slope/average_slope/max_slope in any custom_model — ever.
export const editSegment = action({
  args: {
    mode: v.union(v.literal('redirect'), v.literal('avoid')),
    anchorA: latLng,
    anchorB: latLng,
    via: v.optional(latLng),
    rejectedSubPath: v.optional(v.array(latLng)),
  },
  handler: async (_ctx, { mode, anchorA, anchorB, via, rejectedSubPath }): Promise<EditSegmentResult> => {
    const hosts = [
      process.env.GRAPHHOPPER_URL,
      'http://bordmap-graphhopper:8989',
      'http://hd16llwd4rwxpsxplzieci24:8989',
    ].filter((v, i, a): v is string => Boolean(v) && a.indexOf(v) === i)

    type GhPath = {
      distance: number
      time: number
      points: { coordinates: Array<[number, number, number?]> }
      ascend?: number
      descend?: number
      details?: GhDetails
    }

    // ── Helper: GET route (redirect mode) ──────────────────────────────────
    async function ghGet(params: URLSearchParams): Promise<Response | null> {
      for (const base of hosts) {
        try {
          const ctrl = new AbortController()
          const timeout = setTimeout(() => ctrl.abort(), 10_000)
          const resp = await fetch(`${base}/route?${params.toString()}`, { signal: ctrl.signal })
          clearTimeout(timeout)
          return resp
        } catch { /* try next host */ }
      }
      return null
    }

    // ── Helper: POST route (avoid mode — flexible custom_model) ────────────
    async function ghPost(body: unknown): Promise<Response | null> {
      for (const base of hosts) {
        try {
          const ctrl = new AbortController()
          const timeout = setTimeout(() => ctrl.abort(), 15_000)
          const resp = await fetch(`${base}/route`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal: ctrl.signal,
          })
          clearTimeout(timeout)
          return resp
        } catch { /* try next host */ }
      }
      return null
    }

    // ── Helper: snap a point to the nearest road via GH /nearest ───────────
    // Returns the snapped {lat,lng} when GH confirms a road within snapRadiusM.
    // Returns null when GH confirms distance > snapRadiusM (truly off-network).
    // Returns original {lat,lng} when the endpoint is unavailable (safe pass-through).
    async function ghSnapNearest(
      lat: number, lng: number, snapRadiusM = 100
    ): Promise<{ lat: number; lng: number } | null> {
      for (const base of hosts) {
        let resp: Response
        try {
          const ctrl = new AbortController()
          const timeout = setTimeout(() => ctrl.abort(), 5_000)
          const q = new URLSearchParams({ point: `${lat},${lng}`, profile: 'bordmap_road' })
          resp = await fetch(`${base}/nearest?${q.toString()}`, { signal: ctrl.signal })
          clearTimeout(timeout)
        } catch { continue }
        if (!resp.ok) return { lat, lng }  // endpoint error → pass-through original
        let data: { coordinates?: [number, number, number?]; distance?: number }
        try { data = await resp.json() as typeof data } catch { return { lat, lng } }
        const [snapLng, snapLat] = data.coordinates ?? []
        if (typeof snapLat !== 'number' || typeof snapLng !== 'number') return { lat, lng }
        // GH reports distance in metres from query point to snapped road
        if (typeof data.distance === 'number' && data.distance > snapRadiusM) return null
        return { lat: snapLat, lng: snapLng }
      }
      return { lat, lng }  // all hosts unreachable → pass-through
    }

    // ── Mode C: redirect through via ────────────────────────────────────────
    if (mode === 'redirect') {
      if (!via) {
        return { ok: false, error: 'ROUTING_UNAVAILABLE', message: 'via requis en mode redirect.' }
      }

      // Snap via to nearest road before routing (AC-2 / FEN-1170).
      // POINT_OFF_NETWORK is only raised when GH /nearest confirms no road within the snap radius.
      const snappedVia = await ghSnapNearest(via.lat, via.lng)
      if (!snappedVia) {
        return { ok: false, error: 'POINT_OFF_NETWORK', message: "Ce point n'est pas sur une route — déplacez-le." }
      }

      const params = new URLSearchParams()
      params.append('point', `${anchorA.lat},${anchorA.lng}`)
      params.append('point', `${snappedVia.lat},${snappedVia.lng}`)
      params.append('point', `${anchorB.lat},${anchorB.lng}`)
      params.append('profile', 'bordmap_road')
      params.append('elevation', 'true')
      params.append('points_encoded', 'false')
      params.append('instructions', 'false')
      params.append('calc_points', 'true')
      params.append('details', 'average_slope')

      const resp = await ghGet(params)
      if (!resp) {
        return { ok: false, error: 'ROUTING_UNAVAILABLE', message: 'GraphHopper unreachable' }
      }
      if (!resp.ok) {
        let body: { message?: string } = {}
        try { body = await resp.json() as typeof body } catch { /* ignore */ }
        const msg = body?.message ?? ''
        if (msg.includes('Cannot find point')) {
          return { ok: false, error: 'POINT_OFF_NETWORK', message: "Ce point n'est pas sur une route — déplacez-le." }
        }
        return { ok: false, error: 'ROUTING_UNAVAILABLE', message: msg || `HTTP ${resp.status}` }
      }

      const data = await resp.json() as { paths?: GhPath[] }
      if (!data.paths?.length) {
        return { ok: false, error: 'ROUTING_UNAVAILABLE', message: 'Aucun itinéraire retourné.' }
      }

      const p = data.paths[0]
      const subPath = p.points.coordinates.map(([lng, lat]) => ({ lat, lng }))
      const slopeProfile = extractSlopeProfile(p.details, subPath.length)
      return {
        ok: true,
        edit: {
          subPath,
          slopeProfile,
          stats: {
            distanceMeters: Math.round(p.distance),
            durationSeconds: null,
            maxGradePct: slopeProfile.length > 0 ? Math.max(0, ...slopeProfile) : extractMaxGradePct(p.details),
            counterFlowCount: extractCounterFlowCount(p.details),
          },
        },
      }
    }

    // ── Mode B: avoid — scoped exclusion on rejectedSubPath ─────────────────
    if (!rejectedSubPath?.length) {
      return { ok: false, error: 'ROUTING_UNAVAILABLE', message: 'rejectedSubPath requis en mode avoid.' }
    }

    // Reference distance: length of the sub-path we want to replace (R3 — relative)
    const refDistMeters = Math.round(pathLengthMeters(rejectedSubPath))

    const rejectedHandle: RouteHandle = {
      handle: computeHandle(rejectedSubPath),
      path: rejectedSubPath,
    }

    const AVOID_BUFFER_METERS = [45, 60, 80] as const

    for (let attempt = 0; attempt < AVOID_BUFFER_METERS.length; attempt++) {
      const bufferMeters = AVOID_BUFFER_METERS[attempt]
      const areas = buildExclusionAreas([rejectedHandle], bufferMeters)

      // R7: no slope/average_slope/max_slope in custom_model — only area priority
      const body = {
        profile: 'bordmap_road',
        points: [
          [anchorA.lng, anchorA.lat],
          [anchorB.lng, anchorB.lat],
        ],
        custom_model: {
          priority: [{ if: 'in_avoid_0', multiply_by: 0.05 }],
          areas,
        },
        points_encoded: false,
        elevation: true,
        details: ['average_slope'],
      }

      const resp = await ghPost(body)
      if (!resp) {
        return { ok: false, error: 'ROUTING_UNAVAILABLE', message: 'GraphHopper unreachable' }
      }
      if (!resp.ok) {
        let errBody: { message?: string } = {}
        try { errBody = await resp.json() as typeof errBody } catch { /* ignore */ }
        return { ok: false, error: 'ROUTING_UNAVAILABLE', message: errBody?.message ?? `HTTP ${resp.status}` }
      }

      const data = await resp.json() as { paths?: GhPath[] }
      if (!data.paths?.length) continue

      const p = data.paths[0]
      const subPath = p.points.coordinates.map(([lng, lat]) => ({ lat, lng }))
      const distMeters = Math.round(p.distance)

      // Distinctness: new sub-path must differ from the rejected one (plan §3, R3)
      const overlap = computeOverlapFraction(subPath, [rejectedSubPath], 30)
      if (!passesDistinctnessCheck(overlap)) continue

      // Quality floor relative to the sub-path reference distance (R3)
      // durSec=0 / primaryDurSec=0 → duration check skipped (unreliable for roads vehicle)
      const qf = passesQualityFloor(distMeters, 0, refDistMeters, 0)
      if (!qf.passes) continue

      const slopeProfile = extractSlopeProfile(p.details, subPath.length)
      return {
        ok: true,
        edit: {
          subPath,
          slopeProfile,
          stats: {
            distanceMeters: distMeters,
            durationSeconds: null,
            maxGradePct: slopeProfile.length > 0 ? Math.max(0, ...slopeProfile) : extractMaxGradePct(p.details),
            counterFlowCount: extractCounterFlowCount(p.details),
          },
        },
      }
    }

    // All K attempts exhausted — no local detour between these anchors (#2, non-retryable)
    return {
      ok: false,
      error: 'NO_LOCAL_ROUTE',
      message: 'Aucun détour praticable entre ces ancres — repositionnez les points.',
    }
  },
})
