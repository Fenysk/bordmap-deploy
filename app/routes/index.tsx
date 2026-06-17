import { useState, useCallback } from 'react'
import { createFileRoute, Link } from '@tanstack/react-router'
import { useQuery } from 'convex/react'
// eslint-disable-next-line @typescript-eslint/no-explicit-any
import { api as _api } from '../../convex/_generated/api'
const api = _api as any
import { RouteMap } from '#/components/RouteMap'
import { RouteDetailCard } from '#/components/RouteDetailCard'
import { DIFFICULTY_COLOR } from '#/lib/shared'
import type { BoundingBox, Route as RouteData } from '#/lib/shared'

export const Route = createFileRoute('/')({ component: Home })

function Home() {
  const [bounds, setBounds] = useState<BoundingBox | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)

  const routes = useQuery(
    api.routes.listInBounds,
    bounds !== null ? bounds : 'skip',
  )

  const handleBoundsChange = useCallback((b: BoundingBox) => setBounds(b), [])
  const handleRouteClick = useCallback((id: string) => setSelectedId(id), [])
  const handleCloseDetail = useCallback(() => setSelectedId(null), [])

  const routeList: RouteData[] = (routes as RouteData[] | undefined) ?? []
  const selectedRoute = routeList.find((r) => r._id === selectedId) ?? null

  return (
    <div className="flex min-h-screen flex-col">
      {/* Header */}
      <header className="flex items-center justify-between border-b bg-white px-6 py-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Bordmap</h1>
          <p className="text-sm text-gray-500">
            Découvre les meilleures routes Freebord
          </p>
        </div>
        <Link
          to="/route/new"
          className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
        >
          + Référencer une route
        </Link>
      </header>

      {/* Map */}
      <div className="h-[55vh] w-full">
        <RouteMap
          routes={routeList}
          mode="view"
          onBoundsChange={handleBoundsChange}
          onRouteClick={handleRouteClick}
        />
      </div>

      {/* Route list */}
      <section className="flex-1 border-t bg-white px-6 py-4">
        <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-gray-500">
          Routes dans le viewport
          {routes !== undefined && ` — ${routeList.length}`}
        </h2>

        {/* Loading skeleton */}
        {routes === undefined && (
          <div className="space-y-2">
            {[1, 2, 3].map((i) => (
              <div key={i} className="h-10 animate-pulse rounded-lg bg-gray-100" />
            ))}
          </div>
        )}

        {/* Empty state */}
        {routes !== undefined && routeList.length === 0 && (
          <p className="py-4 text-center text-sm text-gray-400">
            Aucune route référencée dans cette zone. Bougez la carte ou{' '}
            <Link to="/route/new" className="text-blue-600 hover:underline">
              ajoutez la première
            </Link>
            .
          </p>
        )}

        {/* Route list */}
        {routeList.length > 0 && (
          <ul className="max-h-64 space-y-2 overflow-y-auto">
            {routeList.map((r) => (
              <li key={r._id}>
                <button
                  onClick={() => setSelectedId(r._id)}
                  className={`w-full rounded-lg border px-4 py-2.5 text-left transition-colors hover:bg-gray-50 ${
                    selectedId === r._id
                      ? 'border-blue-400 bg-blue-50'
                      : 'border-gray-200 bg-white'
                  }`}
                >
                  <div className="flex items-center gap-2.5">
                    <span
                      className="h-2.5 w-2.5 flex-shrink-0 rounded-full"
                      style={{
                        backgroundColor:
                          DIFFICULTY_COLOR[
                            r.difficulty as keyof typeof DIFFICULTY_COLOR
                          ],
                      }}
                    />
                    <span className="truncate font-medium text-gray-900">
                      {r.name}
                    </span>
                    <span className="ml-auto flex-shrink-0 text-xs text-gray-400">
                      {r.lengthMeters >= 1000
                        ? `${(r.lengthMeters / 1000).toFixed(1)} km`
                        : `${Math.round(r.lengthMeters)} m`}
                    </span>
                  </div>
                  {r.spotName && (
                    <p className="mt-0.5 pl-5 text-xs text-gray-500">
                      {r.spotName}
                    </p>
                  )}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Detail panel */}
      {selectedRoute && (
        <>
          {/* Backdrop */}
          <div
            className="fixed inset-0 z-40 bg-black/20"
            onClick={handleCloseDetail}
          />
          {/* Panel */}
          <aside className="fixed inset-y-0 right-0 z-50 flex w-full max-w-sm flex-col border-l bg-white shadow-2xl">
            <div className="flex items-center justify-between border-b px-4 py-3">
              <span className="font-semibold text-gray-800">Fiche route</span>
              <button
                onClick={handleCloseDetail}
                className="rounded p-1 text-gray-500 hover:bg-gray-100"
                aria-label="Fermer"
              >
                ✕
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-4">
              <RouteDetailCard route={selectedRoute} />
            </div>
          </aside>
        </>
      )}
    </div>
  )
}
