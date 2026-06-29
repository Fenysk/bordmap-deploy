import { createFileRoute } from '@tanstack/react-router'
import { useAction } from 'convex/react'
import { useState, useCallback } from 'react'
import { api } from '../../convex/_generated/api'
import { RouteMap } from '#/components/RouteMap'
import type { SelectedGeometry } from '#/components/RouteMap'
import { SaveRouteButton } from '#/components/SaveRouteButton'
import { toHandle } from '#/lib/route-client'
import type { LatLng, RouteStats } from '#/lib/route-client'
import { findAnchorWindow } from '#/lib/edit/segment-anchors'

export const Route = createFileRoute('/')({ component: Home })

// State machine (FEN-937 §4.6 / FEN-954 S3 / FEN-960 / FEN-994 / FEN-1196 / FEN-1202 / FEN-1239):
// empty → startPlaced → computing → traced ⇌ editing → traced
// editing → traced (ok) | traced (error, routeError set)
// error → computing (retry) | empty (reset)
// Reset always returns to empty.
//
// FEN-1239 changes vs FEN-1202:
// - alternatives removed (single route, no routeIndex/excludes/exhausted/altLoading)
// - pendingContextMenu: segment-tap shows "Supprimer la portion / Annuler" panel
// - sliding-point (via-drag) kept: via marker placed on tap, draggable to reroute
// - end-edit fixed: pinEl pointer-events:none so end marker no longer swallows clicks

type KnownRoute = {
  path: LatLng[]
  stats: RouteStats
  handle: string
  slopeProfile: number[]
}

type AppState =
  | { phase: 'empty' }
  | { phase: 'startPlaced'; start: LatLng }
  | { phase: 'computing'; start: LatLng; end: LatLng }
  | {
      phase: 'traced'
      start: LatLng
      end: LatLng
      route: KnownRoute
      routeError: string | null
      fitTo: LatLng[] | null
      viaPoints: LatLng[]
      directRoute: LatLng[]  // stable reference for via ordering (FEN-1206)
      pendingContextMenu: { tapRef: LatLng } | null  // set when route line tapped
    }
  | {
      phase: 'editing'
      start: LatLng
      end: LatLng
      route: KnownRoute
      viaPoints: LatLng[]
      directRoute: LatLng[]
    }
  | { phase: 'error'; start: LatLng; end: LatLng; message: string }

// Half-window (metres) for "Supprimer la portion" anchor selection.
// findAnchorWindow walks ±SEGMENT_HALF_WINDOW_M from the tap along the route.
const SEGMENT_HALF_WINDOW_M = 300

// ─── Formatting helpers ───────────────────────────────────────────────────────

function formatDistance(meters: number): string {
  if (meters >= 1000) return `${(meters / 1000).toFixed(1)} km`
  return `${Math.round(meters)} m`
}

function formatDuration(seconds: number | null): string {
  if (seconds === null || seconds < 60) return '—'
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  if (h > 0) return `${h} h ${m} min`
  return `${m} min`
}

function formatNullable(value: number | null, suffix: string): string {
  return value === null ? '—' : `${value}${suffix}`
}

// ─── Via-point ordering helpers ───────────────────────────────────────────────

/** Fractional index (0..polyline.length-1) of the closest projection of point onto polyline. */
function projectOntoPolyline(point: LatLng, polyline: LatLng[]): number {
  let best = 0
  let bestDist = Infinity
  for (let i = 0; i < polyline.length - 1; i++) {
    const a = polyline[i], b = polyline[i + 1]
    const ax = b.lng - a.lng, ay = b.lat - a.lat
    const px = point.lng - a.lng, py = point.lat - a.lat
    const len2 = ax * ax + ay * ay
    const t = len2 > 0 ? Math.max(0, Math.min(1, (px * ax + py * ay) / len2)) : 0
    const dx = a.lng + t * ax - point.lng
    const dy = a.lat + t * ay - point.lat
    const d2 = dx * dx + dy * dy
    if (d2 < bestDist) { bestDist = d2; best = i + t }
  }
  return best
}

/**
 * 2-opt decrossing: find any pair of crossing edges in [start, ...order, end]
 * and reverse the sub-path between them. Guaranteed to terminate in O(n³) for
 * n ≤ ~10 vias — each reversal strictly reduces crossing count in the plane.
 */
function eliminateCrossings(order: LatLng[], start: LatLng, end: LatLng): LatLng[] {
  const pts = [start, ...order, end]
  let changed = true
  while (changed) {
    changed = false
    outer: for (let i = 0; i < pts.length - 3; i++) {
      for (let j = i + 2; j < pts.length - 1; j++) {
        if (segmentsProperlyIntersect(pts[i], pts[i + 1], pts[j], pts[j + 1])) {
          const sub = pts.slice(i + 1, j + 1).reverse()
          for (let k = 0; k < sub.length; k++) pts[i + 1 + k] = sub[k]
          changed = true
          break outer
        }
      }
    }
  }
  return pts.slice(1, pts.length - 1)
}

/**
 * Find a via ordering that avoids geometric crossings in [start, ...vias, end].
 * Tries projection on routePath first (natural road order), then falls back to
 * 2-opt decrossing. Replaces sortViasByReference — fixes the catch-22 where
 * dense/lateral vias projected onto the straight line always crossed (FEN-1307).
 */
function findNonCrossingOrder(
  vias: LatLng[],
  start: LatLng,
  end: LatLng,
  routePath: LatLng[],
  directRoute: LatLng[],
): LatLng[] {
  if (vias.length <= 1) return [...vias]
  const ref = routePath.length >= 2 ? routePath : directRoute.length >= 2 ? directRoute : [start, end]
  const byProjection = [...vias].sort(
    (a, b) => projectOntoPolyline(a, ref) - projectOntoPolyline(b, ref),
  )
  if (!routeSelfIntersects([start, ...byProjection, end])) return byProjection
  return eliminateCrossings(byProjection, start, end)
}

/**
 * True if segments a1→a2 and b1→b2 properly cross (endpoints excluded).
 * Uses parametric cross-product test; skips parallel/collinear pairs.
 */
function segmentsProperlyIntersect(
  a1: LatLng, a2: LatLng,
  b1: LatLng, b2: LatLng,
): boolean {
  const d1x = a2.lng - a1.lng, d1y = a2.lat - a1.lat
  const d2x = b2.lng - b1.lng, d2y = b2.lat - b1.lat
  const cross = d1x * d2y - d1y * d2x
  if (Math.abs(cross) < 1e-14) return false
  const ex = b1.lng - a1.lng, ey = b1.lat - a1.lat
  const t = (ex * d2y - ey * d2x) / cross
  const u = (ex * d1y - ey * d1x) / cross
  return t > 1e-6 && t < 1 - 1e-6 && u > 1e-6 && u < 1 - 1e-6
}

/**
 * True if the polyline self-intersects (any pair of non-adjacent segments cross).
 * O(n²) — acceptable for typical route lengths (~100–500 pts → < 5 ms).
 */
function routeSelfIntersects(path: LatLng[]): boolean {
  const n = path.length
  for (let i = 0; i < n - 2; i++) {
    for (let j = i + 2; j < n - 1; j++) {
      if (segmentsProperlyIntersect(path[i], path[i + 1], path[j], path[j + 1])) {
        return true
      }
    }
  }
  return false
}

// ─────────────────────────────────────────────────────────────────────────────

function Home() {
  const [state, setState] = useState<AppState>({ phase: 'empty' })
  const computeRoutes = useAction(api.routing.computeRoutes)

  // Shared route computation: sets computing phase then resolves to traced or error.
  const runRouteComputation = useCallback(
    async (start: LatLng, end: LatLng) => {
      setState({ phase: 'computing', start, end })
      const result = await computeRoutes({ start, end }).catch(() => ({
        ok: false as const,
        error: 'ROUTING_UNAVAILABLE' as const,
        message: 'Service indisponible',
      }))
      setState((prev) => {
        if (prev.phase !== 'computing') return prev
        if (result.ok) {
          const primary = result.candidates[0]
          const route: KnownRoute = {
            path: primary.path,
            stats: primary.stats,
            handle: toHandle(primary.path),
            slopeProfile: primary.slopeProfile,
          }
          return {
            phase: 'traced',
            start: prev.start,
            end: prev.end,
            route,
            routeError: null,
            fitTo: primary.path,
            viaPoints: [],
            directRoute: primary.path,
            pendingContextMenu: null,
          }
        }
        return { phase: 'error', start: prev.start, end: prev.end, message: 'Aucun itinéraire trouvé' }
      })
    },
    [computeRoutes],
  )

  // FEN-1202: via-points compute — reroute with the full ordered vias array.
  // On success: replace current route with the via-route, keep all via markers.
  // On error: return to traced with OLD route, show error, keep via markers at drop positions.
  const runViaCompute = useCallback(
    async (newVias: LatLng[]) => {
      if (state.phase !== 'traced') return
      const captured = state
      setState({
        phase: 'editing',
        start: captured.start,
        end: captured.end,
        route: captured.route,
        viaPoints: newVias,
        directRoute: captured.directRoute,
      })
      const result = await computeRoutes({
        start: captured.start,
        end: captured.end,
        vias: newVias.length > 0 ? newVias : undefined,
      }).catch(() => ({
        ok: false as const,
        error: 'ROUTING_UNAVAILABLE' as const,
        message: 'Service indisponible',
      }))
      setState((prev) => {
        if (prev.phase !== 'editing') return prev
        if (result.ok) {
          const primary = result.candidates[0]
          // Crossing guard: if the new route would self-intersect, reject and snap
          // Soft crossing guard (FEN-1307): findNonCrossingOrder already eliminated
          // geometric crossings before GH routing; if GH still returns a crossing route
          // (rare road-network edge case), keep newVias in place and show a soft hint.
          if (routeSelfIntersects(primary.path)) {
            return {
              phase: 'traced' as const,
              start: prev.start,
              end: prev.end,
              route: captured.route,
              routeError: "Ce point force un croisement — déplace-le légèrement",
              fitTo: null,
              viaPoints: newVias,
              directRoute: prev.directRoute,
              pendingContextMenu: null,
            }
          }
          const newRoute: KnownRoute = {
            path: primary.path,
            stats: primary.stats,
            handle: toHandle(primary.path),
            slopeProfile: primary.slopeProfile,
          }
          return {
            phase: 'traced' as const,
            start: prev.start,
            end: prev.end,
            route: newRoute,
            routeError: null,
            fitTo: null,
            viaPoints: newVias,
            directRoute: prev.directRoute,
            pendingContextMenu: null,
          }
        }
        const message =
          result.error === 'POINT_OFF_NETWORK'
            ? "Ce point n'est pas sur une route — déplace-le"
            : result.error === 'NO_ROUTE'
              ? 'Aucun itinéraire vers ce point — essaie ailleurs'
              : 'Service indisponible — réessaie'
        return {
          phase: 'traced' as const,
          start: prev.start,
          end: prev.end,
          route: captured.route,
          routeError: message,
          fitTo: null,
          viaPoints: newVias,
          directRoute: prev.directRoute,
          pendingContextMenu: null,
        }
      })
    },
    [state, computeRoutes],
  )

  // "Supprimer la portion" (FEN-1247): GLOBAL zone avoidance on the full start→end route.
  // Uses findAnchorWindow to identify the rejected sub-path, then calls computeRoutes
  // with avoidPath so GraphHopper finds a global detour (even if > 300 m away).
  // Replaces the old editSegment(avoid) LOCAL approach that failed in dense areas
  // (Vieux Lyon case: no local detour between anchors 300 m apart → NO_LOCAL_ROUTE).
  const handleAvoidSegment = useCallback(async () => {
    if (state.phase !== 'traced' || !state.pendingContextMenu) return
    const tap = state.pendingContextMenu.tapRef
    const currentPath = state.route.path

    const anchors = findAnchorWindow(currentPath, tap, SEGMENT_HALF_WINDOW_M)
    if (!anchors) {
      setState(prev => {
        if (prev.phase !== 'traced') return prev
        return {
          ...prev,
          pendingContextMenu: null,
          viaPoints: prev.viaPoints.filter(v => v !== tap),
          routeError: 'Aucun segment trouvable — réessaie',
        }
      })
      return
    }

    const captured = state
    // Vias to use for the global re-route: current vias minus the temporary tap marker.
    const viasForRoute = captured.viaPoints.filter(v => v !== tap)

    // Transition to editing: remove the tap via marker.
    setState(prev => {
      if (prev.phase !== 'traced') return prev
      return {
        phase: 'editing' as const,
        start: prev.start,
        end: prev.end,
        route: prev.route,
        viaPoints: viasForRoute,
        directRoute: prev.directRoute,
      }
    })

    // Re-route the FULL start→end with a 45 m exclusion zone around the tapped portion.
    // GH finds a global detour even if the local window has no practicable bypass.
    const result = await computeRoutes({
      start: captured.start,
      end: captured.end,
      vias: viasForRoute.length > 0 ? viasForRoute : undefined,
      avoidPath: anchors.rejectedSubPath,
    }).catch(() => ({
      ok: false as const,
      error: 'ROUTING_UNAVAILABLE' as const,
      message: 'Service indisponible',
    }))

    setState(prev => {
      if (prev.phase !== 'editing') return prev
      if (!result.ok) {
        // AC-2 (FEN-1247): honest error only when NO global detour exists at all.
        const message =
          result.error === 'NO_ROUTE'
            ? 'Aucun itinéraire en évitant cette zone — elle est complètement enclavée'
            : 'Service indisponible — réessaie'
        return {
          phase: 'traced' as const,
          start: prev.start,
          end: prev.end,
          route: captured.route,
          routeError: message,
          fitTo: null,
          viaPoints: viasForRoute,
          directRoute: prev.directRoute,
          pendingContextMenu: null,
        }
      }

      const primary = result.candidates[0]

      // Anti-intersection guard (FEN-1239 AC-4)
      if (routeSelfIntersects(primary.path)) {
        return {
          phase: 'traced' as const,
          start: prev.start,
          end: prev.end,
          route: captured.route,
          routeError: 'Ce contournement crée un croisement — essaie une zone plus petite',
          fitTo: null,
          viaPoints: viasForRoute,
          directRoute: prev.directRoute,
          pendingContextMenu: null,
        }
      }

      const newRoute: KnownRoute = {
        path: primary.path,
        stats: primary.stats,
        handle: toHandle(primary.path),
        slopeProfile: primary.slopeProfile,
      }

      return {
        phase: 'traced' as const,
        start: prev.start,
        end: prev.end,
        route: newRoute,
        routeError: null,
        fitTo: null,
        viaPoints: viasForRoute,  // keep active vias: new route already respects them
        directRoute: prev.directRoute,
        pendingContextMenu: null,
      }
    })
  }, [state, computeRoutes])

  // "Annuler" context menu: remove the temporary tap via, close menu
  const handleCancelContextMenu = useCallback(() => {
    setState(prev => {
      if (prev.phase !== 'traced' || !prev.pendingContextMenu) return prev
      const tap = prev.pendingContextMenu.tapRef
      return {
        ...prev,
        pendingContextMenu: null,
        viaPoints: prev.viaPoints.filter(v => v !== tap),
        routeError: null,
      }
    })
  }, [])

  // Click cycle: empty→startPlaced, startPlaced→route, others→reset
  const handleMapClick = useCallback(
    async (p: LatLng) => {
      if (state.phase === 'empty') {
        setState({ phase: 'startPlaced', start: p })
        return
      }
      if (state.phase === 'startPlaced') {
        await runRouteComputation(state.start, p)
        return
      }
      // traced | editing: off-route clicks are no-ops — route is already placed.
      // computing | error → reset to empty.
      if (state.phase === 'traced' || state.phase === 'editing') return
      setState({ phase: 'empty' })
    },
    [state, runRouteComputation],
  )

  // Route line tap → place via marker + show context menu (FEN-1239).
  // The via marker enables the sliding-point feature (drag to reroute).
  // The context menu enables "Supprimer la portion".
  const handleSegmentTap = useCallback(
    (tap: LatLng) => {
      if (state.phase !== 'traced') return
      setState((prev) => {
        if (prev.phase !== 'traced') return prev
        // If a different tap is already pending, remove its via first
        const filteredVias = prev.pendingContextMenu
          ? prev.viaPoints.filter(v => v !== prev.pendingContextMenu!.tapRef)
          : prev.viaPoints
        const tapRef = tap
        const newViaPoints = findNonCrossingOrder(
          [...filteredVias, tapRef],
          prev.start,
          prev.end,
          prev.route.path,
          prev.directRoute,
        )
        return {
          ...prev,
          viaPoints: newViaPoints,
          routeError: null,
          pendingContextMenu: { tapRef },
        }
      })
    },
    [state.phase],
  )

  // Via drag START → dismiss context menu immediately (FEN-1239 UX)
  const handleViaPointDragStart = useCallback((_index: number) => {
    setState(prev => {
      if (prev.phase !== 'traced' || !prev.pendingContextMenu) return prev
      return { ...prev, pendingContextMenu: null }
    })
  }, [])

  // Via-point drag end → update position, reorder by stable reference, reroute (FEN-1206).
  const handleViaPointDrag = useCallback(
    async (index: number, newPos: LatLng) => {
      if (state.phase !== 'traced') return
      const updated = [...state.viaPoints]
      updated[index] = newPos
      const newVias = findNonCrossingOrder(updated, state.start, state.end, state.route.path, state.directRoute)
      await runViaCompute(newVias)
    },
    [state, runViaCompute],
  )

  // Tap on via marker → delete it.
  // Special case: if it is the pending context-menu tap, treat as "Annuler" (no reroute).
  const handleViaPointDelete = useCallback(
    async (index: number) => {
      if (state.phase !== 'traced') return
      // If the deleted via is the pending context-menu tap, just cancel
      if (
        state.pendingContextMenu &&
        state.viaPoints[index] === state.pendingContextMenu.tapRef
      ) {
        setState(prev => {
          if (prev.phase !== 'traced') return prev
          return {
            ...prev,
            viaPoints: prev.viaPoints.filter((_, i) => i !== index),
            pendingContextMenu: null,
            routeError: null,
          }
        })
        return
      }
      const filtered = state.viaPoints.filter((_, i) => i !== index)
      const newVias = findNonCrossingOrder(filtered, state.start, state.end, state.route.path, state.directRoute)
      await runViaCompute(newVias)
    },
    [state, runViaCompute],
  )

  // AC-5: retry engine error without losing points A and B
  const handleRetry = useCallback(async () => {
    if (state.phase !== 'error') return
    await runRouteComputation(state.start, state.end)
  }, [state, runRouteComputation])

  // ─── Derive RouteMap props from discriminated union ───────────────────────────

  const mapStart = state.phase !== 'empty' ? state.start : null
  const mapEnd =
    state.phase !== 'empty' && state.phase !== 'startPlaced' ? state.end : null

  const hasRoute = state.phase === 'traced' || state.phase === 'editing'
  const currentRoute = hasRoute ? state.route : null
  const routePath = currentRoute?.path ?? null
  const fitTo = state.phase === 'traced' ? state.fitTo : null

  const geometry: SelectedGeometry | null =
    state.phase === 'traced' && currentRoute
      ? {
          start: state.start,
          end: state.end,
          path: currentRoute.path,
          distanceMeters: currentRoute.stats.distanceMeters,
        }
      : null

  // FEN-1202: via-points visible in both traced and editing phases
  const mapViaPoints =
    state.phase === 'traced' || state.phase === 'editing'
      ? state.viaPoints
      : []

  const hasPendingMenu = state.phase === 'traced' && state.pendingContextMenu !== null

  return (
    <div className="relative h-screen w-full">
      <RouteMap
        start={mapStart}
        end={mapEnd}
        routePath={routePath}
        onMapClick={handleMapClick}
        fitTo={fitTo}
        onSegmentTap={handleSegmentTap}
        viaPoints={mapViaPoints}
        onViaPointDrag={handleViaPointDrag}
        onViaPointDragStart={handleViaPointDragStart}
        onViaPointDelete={handleViaPointDelete}
      />

      {/* spinner during initial route computation */}
      {state.phase === 'computing' && (
        <div className="pointer-events-none absolute inset-x-0 top-4 flex justify-center">
          <div className="rounded-full bg-white px-4 py-2 text-sm shadow">
            Calcul en cours…
          </div>
        </div>
      )}

      {/* spinner during via-point reroute or segment suppression */}
      {state.phase === 'editing' && (
        <div className="pointer-events-none absolute inset-x-0 top-4 flex justify-center">
          <div className="rounded-full bg-white px-4 py-2 text-sm shadow">
            Modification en cours…
          </div>
        </div>
      )}

      {/* initial routing error banner — AC-5: retry preserves A/B */}
      {state.phase === 'error' && (
        <div className="absolute inset-x-0 top-4 flex justify-center">
          <div className="flex items-center gap-3 rounded-full bg-red-50 px-4 py-2 text-sm text-red-700 shadow">
            <span>{state.message}</span>
            <button
              onClick={handleRetry}
              className="rounded-full bg-red-200 px-3 py-1 text-xs font-medium hover:bg-red-300"
            >
              Réessaie
            </button>
          </div>
        </div>
      )}

      {/* traced: route panel with stats + optional context menu */}
      {state.phase === 'traced' && currentRoute && (
        <div className="absolute inset-x-0 bottom-8 flex justify-center">
          <div className="flex min-w-[280px] flex-col items-center gap-3 rounded-xl bg-white p-4 shadow-lg">

            {/* via hint — updated when context menu is showing */}
            {state.viaPoints.length > 0 && (
              <p className="text-xs text-center text-sky-600">
                {hasPendingMenu
                  ? 'Glisse le point · ou choisis une action ci-dessous'
                  : state.viaPoints.length === 1
                    ? 'Point placé — glisse pour modifier · tape pour supprimer'
                    : `${state.viaPoints.length} points — glisse ou tape pour supprimer`}
              </p>
            )}

            {/* route stats */}
            <div className="w-full">
              <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
                <span className="text-gray-500">Distance</span>
                <span className="font-medium">
                  {formatDistance(currentRoute.stats.distanceMeters)}
                </span>
                <span className="text-gray-500">Durée</span>
                <span className="font-medium">
                  {formatDuration(currentRoute.stats.durationSeconds)}
                </span>
                <span className="text-gray-500">Pente max</span>
                <span className="font-medium">
                  {formatNullable(currentRoute.stats.maxGradePct, '%')}
                </span>
                <span className="text-gray-500">Contre-sens</span>
                <span className="font-medium">
                  {formatNullable(currentRoute.stats.counterFlowCount, '')}
                </span>
              </div>
            </div>

            {/* routing error (via drag / segment suppress) */}
            {state.routeError && (
              <p className="text-xs text-red-600">{state.routeError}</p>
            )}

            {/* context menu OR save button */}
            {hasPendingMenu ? (
              <div className="flex flex-wrap justify-center gap-2">
                <button
                  onClick={handleAvoidSegment}
                  className="rounded-lg bg-red-100 px-4 py-2 text-sm font-medium text-red-700 hover:bg-red-200"
                >
                  Supprimer la portion
                </button>
                <button
                  onClick={handleCancelContextMenu}
                  className="rounded-lg bg-gray-100 px-4 py-2 text-sm text-gray-700 hover:bg-gray-200"
                >
                  Annuler
                </button>
              </div>
            ) : (
              <div className="flex justify-center">
                <SaveRouteButton geometry={geometry} />
              </div>
            )}
          </div>
        </div>
      )}

      {/* reset button visible once a point is placed */}
      {state.phase !== 'empty' && (
        <div className="absolute right-4 top-4">
          <button
            onClick={() => setState({ phase: 'empty' })}
            className="rounded-lg bg-white px-3 py-2 text-sm shadow hover:bg-gray-50"
          >
            Réinitialiser
          </button>
        </div>
      )}
    </div>
  )
}
