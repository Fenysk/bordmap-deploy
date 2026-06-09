/**
 * Interactive map: view mode (coloured route lines) + draw mode (R2 real routing).
 * Draw flow: tap D → tap A → auto-route → alternatives → tap to select (auto-confirm) → Recommencer.
 * Via-point: tap map in selecting state → re-snap through that point (single route, no alternatives).
 * Client-only — MapLibre GL uses WebGL/DOM and cannot run during SSR.
 */
import 'maplibre-gl/dist/maplibre-gl.css'
import { useEffect, useRef, useState, useCallback } from 'react'
import { useAction } from 'convex/react'
// eslint-disable-next-line @typescript-eslint/no-explicit-any
import { api as _api } from '../../convex/_generated/api'
const api = _api as any
import { DIFFICULTY_COLOR } from '#/lib/shared'
import type { BoundingBox, Route, LatLng, RouteCandidate, RouteElevation } from '#/lib/shared'

const MAX_CANDIDATES = 3
const CAND_COLORS = ['#3b82f6', '#94a3b8', '#94a3b8'] // primary blue, others gray
const CAND_WIDTH_SELECTED = 6
const CAND_WIDTH_DEFAULT = 4
const CAND_HIT_LAYERS = Array.from({ length: MAX_CANDIDATES }, (_, i) => `cand-hit-${i}`)

type DrawStep = 'idle' | 'placing-end' | 'routing' | 'selecting'

export interface SelectedGeometry {
  start: LatLng
  end: LatLng
  path: Array<LatLng>
  elevation: RouteElevation | null
}

export interface RouteMapProps {
  routes: Array<Route>
  mode: 'view' | 'draw'
  onBoundsChange?: (bounds: BoundingBox) => void
  onGeometrySelect?: (geometry: SelectedGeometry) => void
}

function buildRoutesGeoJSON(routes: Array<Route>) {
  return {
    type: 'FeatureCollection' as const,
    features: routes.map((r) => ({
      type: 'Feature' as const,
      properties: { id: r._id, color: DIFFICULTY_COLOR[r.difficulty] },
      geometry: {
        type: 'LineString' as const,
        coordinates: [
          [r.start.lng, r.start.lat],
          ...(r.path ?? []).map((p) => [p.lng, p.lat]),
          [r.end.lng, r.end.lat],
        ],
      },
    })),
  }
}

function candidateGeoJSON(candidate: RouteCandidate) {
  return {
    type: 'FeatureCollection' as const,
    features: [
      {
        type: 'Feature' as const,
        properties: {},
        geometry: {
          type: 'LineString' as const,
          coordinates: candidate.path.map((p) => [p.lng, p.lat]),
        },
      },
    ],
  }
}

const emptyGeoJSON = { type: 'FeatureCollection' as const, features: [] }

function makeMarkerEl(label: string, color: string) {
  const el = document.createElement('div')
  el.style.cssText = `
    width: 28px; height: 28px; border-radius: 50%; display: flex;
    align-items: center; justify-content: center; font-weight: bold;
    font-size: 13px; color: white; border: 2px solid white;
    box-shadow: 0 1px 4px rgba(0,0,0,.4); cursor: default;
    background: ${color};
  `
  el.textContent = label
  return el
}

function fmtDistance(m: number) {
  return m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${m} m`
}

function fmtElevation(elev: RouteElevation | null) {
  if (!elev) return null
  return `D+ ${elev.gainMeters} m · D− ${elev.dropMeters} m`
}

export function RouteMap({ routes, mode, onBoundsChange, onGeometrySelect }: RouteMapProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<any>(null)
  const startMarkerRef = useRef<any>(null)
  const endMarkerRef = useRef<any>(null)
  const viaMarkerRef = useRef<any>(null)
  const routesRef = useRef(routes)
  const onBoundsRef = useRef(onBoundsChange)
  const onGeometryRef = useRef(onGeometrySelect)

  const [mounted, setMounted] = useState(false)
  const [drawStep, setDrawStep] = useState<DrawStep>('idle')
  const [startPin, setStartPin] = useState<LatLng | null>(null)
  const [endPin, setEndPin] = useState<LatLng | null>(null)
  const [candidates, setCandidates] = useState<RouteCandidate[]>([])
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [routingError, setRoutingError] = useState<string | null>(null)

  // Refs for stable map event handlers
  const drawStepRef = useRef<DrawStep>('idle')
  const startPinRef = useRef<LatLng | null>(null)
  const endPinRef = useRef<LatLng | null>(null)
  const candidatesRef = useRef<RouteCandidate[]>([])
  const selectedIndexRef = useRef(0)

  routesRef.current = routes
  onBoundsRef.current = onBoundsChange
  onGeometryRef.current = onGeometrySelect
  drawStepRef.current = drawStep
  startPinRef.current = startPin
  endPinRef.current = endPin
  candidatesRef.current = candidates
  selectedIndexRef.current = selectedIndex

  const computeRoutes = useAction(api.routing.computeRoutes)

  // Routing trigger — called after end pin is placed or via-point added
  const triggerRoutingRef = useRef<((start: LatLng, end: LatLng, via?: LatLng) => Promise<void>) | null>(null)
  triggerRoutingRef.current = async (start: LatLng, end: LatLng, via?: LatLng) => {
    setDrawStep('routing')
    setRoutingError(null)
    const result = await computeRoutes({ start, end, ...(via ? { via } : {}) })
    if (!result.ok) {
      setRoutingError(result.message)
      setDrawStep('placing-end')
      return
    }
    setCandidates(result.candidates)
    setSelectedIndex(0)
    setDrawStep('selecting')
    onGeometryRef.current?.({
      start,
      end,
      path: result.candidates[0].path,
      elevation: result.candidates[0].elevation,
    })
  }

  // Candidate selection — called from map click on candidate layer or overlay tap
  const selectCandidateRef = useRef<((idx: number) => void) | null>(null)
  selectCandidateRef.current = (idx: number) => {
    const cands = candidatesRef.current
    const start = startPinRef.current
    const end = endPinRef.current
    if (!cands[idx] || !start || !end) return
    setSelectedIndex(idx)
    onGeometryRef.current?.({
      start,
      end,
      path: cands[idx].path,
      elevation: cands[idx].elevation,
    })
  }

  useEffect(() => setMounted(true), [])

  // Init MapLibre
  useEffect(() => {
    if (!mounted || !containerRef.current) return
    let destroyed = false

    const init = async () => {
      const ml = await import('maplibre-gl')
      if (destroyed || !containerRef.current) return

      const map = new ml.Map({
        container: containerRef.current,
        style: {
          version: 8,
          sources: {
            osm: {
              type: 'raster',
              tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
              tileSize: 256,
              attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
              maxzoom: 19,
            },
          },
          layers: [{ id: 'osm', type: 'raster', source: 'osm' }],
        },
        center: [2.35, 46.85],
        zoom: 5,
      })

      map.addControl(new ml.NavigationControl(), 'top-right')
      mapRef.current = map

      map.on('load', () => {
        if (destroyed) return

        // Existing routes layer (view mode background)
        map.addSource('routes', { type: 'geojson', data: buildRoutesGeoJSON(routesRef.current) })
        map.addLayer({
          id: 'routes-line',
          type: 'line',
          source: 'routes',
          paint: { 'line-color': ['get', 'color'], 'line-width': 4, 'line-opacity': 0.85 },
        })

        // Candidate layers pool (draw mode)
        for (let i = 0; i < MAX_CANDIDATES; i++) {
          map.addSource(`cand-${i}`, { type: 'geojson', data: emptyGeoJSON })
          // Visible line
          map.addLayer({
            id: `cand-line-${i}`,
            type: 'line',
            source: `cand-${i}`,
            paint: {
              'line-color': CAND_COLORS[i] ?? CAND_COLORS[CAND_COLORS.length - 1],
              'line-width': i === 0 ? CAND_WIDTH_SELECTED : CAND_WIDTH_DEFAULT,
              'line-opacity': 0.9,
            },
          })
          // Wide transparent hit area for easy tapping
          map.addLayer({
            id: `cand-hit-${i}`,
            type: 'line',
            source: `cand-${i}`,
            paint: { 'line-color': 'rgba(0,0,0,0)', 'line-width': 20 },
          })
          // Hover cursor
          map.on('mouseenter', `cand-hit-${i}`, () => { map.getCanvas().style.cursor = 'pointer' })
          map.on('mouseleave', `cand-hit-${i}`, () => { map.getCanvas().style.cursor = mode === 'draw' ? 'crosshair' : '' })
        }

        // Bounds listener
        const fireBounds = () => {
          if (!onBoundsRef.current) return
          const b = map.getBounds()
          onBoundsRef.current({ minLat: b.getSouth(), minLng: b.getWest(), maxLat: b.getNorth(), maxLng: b.getEast() })
        }
        map.on('moveend', fireBounds)
        fireBounds()

        if (mode === 'draw') {
          map.getCanvas().style.cursor = 'crosshair'

          map.on('click', (e: any) => {
            const step = drawStepRef.current
            if (step === 'routing') return // ignore during routing

            // Check if click lands on a candidate hit layer
            const hits = map.queryRenderedFeatures(e.point, { layers: CAND_HIT_LAYERS })
            if (hits.length > 0 && step === 'selecting') {
              const layerId: string = hits[0].layer.id // e.g. 'cand-hit-2'
              const idx = parseInt(layerId.split('-').pop()!, 10)
              selectCandidateRef.current?.(idx)
              return
            }

            const { lng, lat } = e.lngLat
            const lngLat: LatLng = { lat, lng }

            if (step === 'idle') {
              // Place start
              startMarkerRef.current?.remove()
              endMarkerRef.current?.remove()
              viaMarkerRef.current?.remove()
              startMarkerRef.current = new ml.Marker({ element: makeMarkerEl('D', '#16a34a') })
                .setLngLat([lng, lat]).addTo(map)
              endMarkerRef.current = null
              viaMarkerRef.current = null
              setStartPin(lngLat)
              setEndPin(null)
              setCandidates([])
              setRoutingError(null)
              setDrawStep('placing-end')
            } else if (step === 'placing-end') {
              // Place end → auto-route
              endMarkerRef.current?.remove()
              endMarkerRef.current = new ml.Marker({ element: makeMarkerEl('A', '#dc2626') })
                .setLngLat([lng, lat]).addTo(map)
              setEndPin(lngLat)
              const start = startPinRef.current
              if (start) void triggerRoutingRef.current?.(start, lngLat)
            } else if (step === 'selecting') {
              // No candidate hit → add via-point → re-route
              viaMarkerRef.current?.remove()
              viaMarkerRef.current = new ml.Marker({ element: makeMarkerEl('V', '#7c3aed') })
                .setLngLat([lng, lat]).addTo(map)
              const start = startPinRef.current
              const end = endPinRef.current
              if (start && end) void triggerRoutingRef.current?.(start, end, lngLat)
            }
          })
        }
      })
    }

    void init()

    return () => {
      destroyed = true
      startMarkerRef.current?.remove()
      endMarkerRef.current?.remove()
      viaMarkerRef.current?.remove()
      startMarkerRef.current = null
      endMarkerRef.current = null
      viaMarkerRef.current = null
      mapRef.current?.remove()
      mapRef.current = null
    }
  }, [mounted, mode])

  // Sync routes data when prop changes
  useEffect(() => {
    const map = mapRef.current
    if (!map?.isStyleLoaded()) return
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(map.getSource('routes') as any)?.setData(buildRoutesGeoJSON(routes))
  }, [routes])

  // Sync candidate layers when candidates or selection change
  useEffect(() => {
    const map = mapRef.current
    if (!map?.isStyleLoaded()) return
    for (let i = 0; i < MAX_CANDIDATES; i++) {
      const src = map.getSource(`cand-${i}`) as any
      if (!src) continue
      src.setData(i < candidates.length ? candidateGeoJSON(candidates[i]) : emptyGeoJSON)
      if (map.getLayer(`cand-line-${i}`)) {
        const isSelected = i === selectedIndex
        map.setPaintProperty(`cand-line-${i}`, 'line-color', isSelected ? '#3b82f6' : '#94a3b8')
        map.setPaintProperty(`cand-line-${i}`, 'line-width', isSelected ? CAND_WIDTH_SELECTED : CAND_WIDTH_DEFAULT)
        map.setPaintProperty(`cand-line-${i}`, 'line-opacity', candidates[i] ? 0.9 : 0)
      }
    }
  }, [candidates, selectedIndex])

  const handleReset = useCallback(() => {
    startMarkerRef.current?.remove()
    endMarkerRef.current?.remove()
    viaMarkerRef.current?.remove()
    startMarkerRef.current = null
    endMarkerRef.current = null
    viaMarkerRef.current = null
    setStartPin(null)
    setEndPin(null)
    setCandidates([])
    setSelectedIndex(0)
    setRoutingError(null)
    setDrawStep('idle')
    // Clear candidate layers
    const map = mapRef.current
    if (map?.isStyleLoaded()) {
      for (let i = 0; i < MAX_CANDIDATES; i++) {
        ;(map.getSource(`cand-${i}`) as any)?.setData(emptyGeoJSON)
      }
    }
  }, [])

  if (!mounted) {
    return (
      <div className="flex h-full min-h-64 w-full items-center justify-center rounded border border-dashed border-gray-300 bg-gray-50 text-sm text-gray-400">
        Chargement de la carte…
      </div>
    )
  }

  const selectedCandidate = candidates[selectedIndex] ?? null

  return (
    <div className="relative h-full w-full">
      <div ref={containerRef} className="h-full w-full rounded" />

      {mode === 'draw' && (
        <div className="pointer-events-none absolute inset-x-0 top-2 flex justify-center">
          <div className="pointer-events-auto max-w-xs rounded-lg bg-white px-3 py-1.5 text-xs font-medium shadow">
            {drawStep === 'idle' && (
              <span>Posez le départ <span className="font-bold text-green-700">D</span></span>
            )}
            {drawStep === 'placing-end' && (
              <span>Posez l'arrivée <span className="font-bold text-red-600">A</span></span>
            )}
            {drawStep === 'routing' && (
              <span className="text-blue-600">Calcul de l'itinéraire…</span>
            )}
            {drawStep === 'selecting' && routingError && (
              <span className="text-red-700">{routingError}</span>
            )}
            {drawStep === 'selecting' && !routingError && selectedCandidate && (
              <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span className="font-bold text-blue-700">
                  {fmtDistance(selectedCandidate.lengthMeters)}
                </span>
                {fmtElevation(selectedCandidate.elevation) && (
                  <span className="text-gray-600">{fmtElevation(selectedCandidate.elevation)}</span>
                )}
                {candidates.length > 1 && (
                  <span className="text-gray-500">
                    Itinéraire {selectedIndex + 1}/{candidates.length}
                    {' '}· tap autre tracé pour changer
                  </span>
                )}
                <button
                  className="rounded bg-gray-200 px-2 py-0.5 text-gray-700 hover:bg-gray-300"
                  onClick={handleReset}
                >
                  Recommencer
                </button>
              </span>
            )}
          </div>
        </div>
      )}

      {/* Candidate selector chips (draw mode, selecting state, >1 candidate) */}
      {mode === 'draw' && drawStep === 'selecting' && candidates.length > 1 && (
        <div className="pointer-events-none absolute inset-x-0 bottom-4 flex justify-center gap-2">
          {candidates.map((c, i) => (
            <button
              key={i}
              className={`pointer-events-auto rounded-full px-3 py-1 text-xs font-medium shadow transition-colors ${
                i === selectedIndex
                  ? 'bg-blue-600 text-white'
                  : 'bg-white text-gray-700 hover:bg-gray-100'
              }`}
              onClick={() => selectCandidateRef.current?.(i)}
            >
              {i === 0 ? 'Principal' : `Alternatif ${i}`} · {fmtDistance(c.lengthMeters)}
            </button>
          ))}
        </div>
      )}

      {/* No-route error with reposition hint (AC-6) */}
      {mode === 'draw' && drawStep === 'placing-end' && routingError && (
        <div className="pointer-events-none absolute inset-x-4 bottom-4">
          <div className="pointer-events-auto rounded-lg bg-red-50 border border-red-200 px-3 py-2 text-sm text-red-700 shadow">
            {routingError} — repositionnez <span className="font-bold">D</span> ou <span className="font-bold">A</span>.
          </div>
        </div>
      )}
    </div>
  )
}

export default RouteMap
