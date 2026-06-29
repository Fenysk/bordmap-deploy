import { useEffect, useRef, useState } from 'react'
import maplibregl from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import type { LatLng } from '#/lib/shared/geo'

export interface RouteMapProps {
  start: LatLng | null
  end: LatLng | null
  routePath: LatLng[] | null
  onMapClick: (p: LatLng) => void
  fitTo?: LatLng[] | null
  onSegmentTap?: (tap: LatLng) => void        // tap on route line → add via + show menu
  viaPoints?: LatLng[]                        // FEN-1202: multiple via-point markers
  onViaPointDragStart?: (index: number) => void  // FEN-1239: drag start → dismiss menu
  onViaPointDrag?: (index: number, newPos: LatLng) => void  // via dragged → reroute
  onViaPointDelete?: (index: number) => void                 // tap via → delete
}

// Kept for streams 3c/3d — shape of a saveable completed route
export interface SelectedGeometry {
  start: LatLng
  end: LatLng
  path: Array<LatLng>
  distanceMeters: number
}

export const DEFAULT_VIEW = {
  center: { lat: 45.75, lng: 4.85 },
  zoom: 9,
} as const

const OSM_STYLE: maplibregl.StyleSpecification = {
  version: 8,
  sources: {
    osm: {
      type: 'raster',
      tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
      tileSize: 256,
      attribution:
        '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    },
  },
  layers: [{ id: 'osm', type: 'raster', source: 'osm' }],
}

const ROUTE_SOURCE = 'route-path'
const ROUTE_LINE_LAYER = 'route-line'
const ROUTE_HIT_LAYER = 'route-hit' // wide transparent layer for touch tolerance

function pointsToBounds(points: LatLng[]): maplibregl.LngLatBoundsLike {
  let minLng = Infinity,
    maxLng = -Infinity,
    minLat = Infinity,
    maxLat = -Infinity
  for (const p of points) {
    if (p.lng < minLng) minLng = p.lng
    if (p.lng > maxLng) maxLng = p.lng
    if (p.lat < minLat) minLat = p.lat
    if (p.lat > maxLat) maxLat = p.lat
  }
  return [
    [minLng, minLat],
    [maxLng, maxLat],
  ]
}

function pinEl(color: string): HTMLElement {
  const el = document.createElement('div')
  el.setAttribute(
    'style',
    `width:14px;height:14px;background:${color};border:2.5px solid white;` +
      `border-radius:50%;box-shadow:0 1px 4px rgba(0,0,0,.4);pointer-events:none`,
  )
  return el
}

/** Touch-friendly draggable handle for the via-point (FEN-1196). Sky-blue circle. */
function viaHandleEl(): HTMLElement {
  const outer = document.createElement('div')
  outer.setAttribute(
    'style',
    `width:44px;height:44px;display:flex;align-items:center;justify-content:center;cursor:grab`,
  )
  const inner = document.createElement('div')
  inner.setAttribute(
    'style',
    `width:18px;height:18px;background:#0ea5e9;border:3px solid white;` +
      `border-radius:50%;box-shadow:0 2px 6px rgba(0,0,0,.45);pointer-events:none`,
  )
  outer.appendChild(inner)
  return outer
}

export function RouteMap({
  start,
  end,
  routePath,
  onMapClick,
  fitTo,
  onSegmentTap,
  viaPoints,
  onViaPointDragStart,
  onViaPointDrag,
  onViaPointDelete,
}: RouteMapProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<maplibregl.Map | null>(null)
  const startMarkerRef = useRef<maplibregl.Marker | null>(null)
  const endMarkerRef = useRef<maplibregl.Marker | null>(null)
  const viaMarkersRef = useRef<maplibregl.Marker[]>([])
  const [mapReady, setMapReady] = useState(false)
  const [tilesLoading, setTilesLoading] = useState(false)
  const onMapClickRef = useRef(onMapClick)
  const onSegmentTapRef = useRef(onSegmentTap)
  const onViaPointDragStartRef = useRef(onViaPointDragStart)
  const onViaPointDragRef = useRef(onViaPointDrag)
  const onViaPointDeleteRef = useRef(onViaPointDelete)
  onMapClickRef.current = onMapClick
  onSegmentTapRef.current = onSegmentTap
  onViaPointDragStartRef.current = onViaPointDragStart
  onViaPointDragRef.current = onViaPointDrag
  onViaPointDeleteRef.current = onViaPointDelete

  // Init map (once)
  useEffect(() => {
    if (!containerRef.current) return

    const map = new maplibregl.Map({
      container: containerRef.current,
      style: OSM_STYLE,
      center: [DEFAULT_VIEW.center.lng, DEFAULT_VIEW.center.lat],
      zoom: DEFAULT_VIEW.zoom,
    })
    mapRef.current = map

    let live = true
    map.on('dataloading', () => live && setTilesLoading(true))
    map.on('idle', () => live && setTilesLoading(false))
    map.on('click', (e) => {
      const pt = { lat: e.lngLat.lat, lng: e.lngLat.lng }
      // Route-line tap → segment selection (AC-2 comfortable tap box T=20px).
      // Plain map click → point placement.
      const T = 20
      const box: [maplibregl.PointLike, maplibregl.PointLike] = [
        [e.point.x - T, e.point.y - T],
        [e.point.x + T, e.point.y + T],
      ]
      const routeHit = map.queryRenderedFeatures(box, { layers: [ROUTE_LINE_LAYER, ROUTE_HIT_LAYER] })
      if (routeHit.length > 0 && onSegmentTapRef.current) {
        onSegmentTapRef.current(pt)
      } else {
        onMapClickRef.current(pt)
      }
    })
    map.on('load', () => {
      if (!live) return
      map.addSource(ROUTE_SOURCE, {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      })
      map.addLayer({
        id: ROUTE_LINE_LAYER,
        type: 'line',
        source: ROUTE_SOURCE,
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: { 'line-color': '#3b82f6', 'line-width': 4, 'line-opacity': 0.85 },
      })
      // Wide invisible layer to improve finger-tap hit surface on touch devices (AC-2).
      map.addLayer({
        id: ROUTE_HIT_LAYER,
        type: 'line',
        source: ROUTE_SOURCE,
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: { 'line-color': '#000000', 'line-width': 38, 'line-opacity': 0 },
      })
      // Show grab cursor when hovering the route line (FEN-1196 UX hint).
      map.on('mousemove', ROUTE_HIT_LAYER, () => { map.getCanvas().style.cursor = 'grab' })
      map.on('mouseleave', ROUTE_HIT_LAYER, () => { map.getCanvas().style.cursor = '' })
      setMapReady(true)
    })

    return () => {
      live = false
      startMarkerRef.current?.remove()
      endMarkerRef.current?.remove()
      viaMarkersRef.current.forEach(m => m.remove())
      startMarkerRef.current = null
      endMarkerRef.current = null
      viaMarkersRef.current = []
      map.remove()
      mapRef.current = null
      setMapReady(false)
    }
  }, [])

  // Sync start marker (green — AC-2.5)
  useEffect(() => {
    if (!mapReady || !mapRef.current) return
    startMarkerRef.current?.remove()
    startMarkerRef.current = null
    if (start) {
      startMarkerRef.current = new maplibregl.Marker({ element: pinEl('#22c55e') })
        .setLngLat([start.lng, start.lat])
        .addTo(mapRef.current)
    }
  }, [start, mapReady])

  // Sync end marker (red — AC-2.5)
  useEffect(() => {
    if (!mapReady || !mapRef.current) return
    endMarkerRef.current?.remove()
    endMarkerRef.current = null
    if (end) {
      endMarkerRef.current = new maplibregl.Marker({ element: pinEl('#ef4444') })
        .setLngLat([end.lng, end.lat])
        .addTo(mapRef.current)
    }
  }, [end, mapReady])

  // Sync route polyline — AC-3.3
  useEffect(() => {
    if (!mapReady || !mapRef.current) return
    const source = mapRef.current.getSource<maplibregl.GeoJSONSource>(ROUTE_SOURCE)
    if (!source) return
    const coords =
      routePath && routePath.length >= 2
        ? routePath.map((p) => [p.lng, p.lat] as [number, number])
        : ([] as [number, number][])
    source.setData({
      type: 'Feature',
      properties: {},
      geometry: { type: 'LineString', coordinates: coords },
    })
  }, [routePath, mapReady])

  // fitTo → fitBounds — AC-3.3/5.3
  useEffect(() => {
    if (!mapReady || !mapRef.current || !fitTo || fitTo.length < 2) return
    mapRef.current.fitBounds(pointsToBounds(fitTo), { padding: 60, maxZoom: 16 })
  }, [fitTo, mapReady])

  // Sync via-point markers — FEN-1202: multiple draggable sky-blue circles.
  // Same count → position-only update (no flicker on drag end).
  // Count changed → recreate all (add/delete are infrequent).
  useEffect(() => {
    if (!mapReady || !mapRef.current) return

    const vp = viaPoints ?? []

    if (viaMarkersRef.current.length === vp.length) {
      for (let i = 0; i < vp.length; i++) {
        viaMarkersRef.current[i].setLngLat([vp[i].lng, vp[i].lat])
      }
      return
    }

    viaMarkersRef.current.forEach(m => m.remove())
    viaMarkersRef.current = []

    const map = mapRef.current  // non-null: checked at effect entry
    for (let i = 0; i < vp.length; i++) {
      const idx = i
      const marker = new maplibregl.Marker({ element: viaHandleEl(), draggable: true })
        .setLngLat([vp[i].lng, vp[i].lat])
        .addTo(map)

      marker.on('dragstart', () => {
        marker.getElement().style.cursor = 'grabbing'
        onViaPointDragStartRef.current?.(idx)
      })
      marker.on('dragend', () => {
        marker.getElement().style.cursor = 'grab'
        const { lng, lat } = marker.getLngLat()
        onViaPointDragRef.current?.(idx, { lat, lng })
      })
      marker.getElement().addEventListener('click', (e) => {
        e.stopPropagation()
        onViaPointDeleteRef.current?.(idx)
      })

      viaMarkersRef.current.push(marker)
    }
  }, [viaPoints, mapReady])

  return (
    <div className="relative h-full w-full">
      <div ref={containerRef} className="h-full w-full" />

      {/* AC-1.4 — tile loading indicator */}
      {tilesLoading && (
        <div className="pointer-events-none absolute right-2 top-2 rounded bg-white/80 px-2 py-1 text-xs text-gray-500 shadow-sm">
          Chargement…
        </div>
      )}

      {/* AC-1.3 — readable empty state */}
      {!start && !end && !routePath && (
        <div className="pointer-events-none absolute inset-x-0 bottom-16 flex justify-center">
          <p className="rounded-lg bg-white/85 px-4 py-2 text-sm text-gray-500 shadow-sm backdrop-blur-sm">
            Cliquez sur la carte pour placer le départ
          </p>
        </div>
      )}
    </div>
  )
}

export default RouteMap
