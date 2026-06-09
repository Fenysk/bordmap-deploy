/**
 * /route/new — auth-gated page to reference a new route.
 * Split layout: map (draw mode, left/top) + form (right/bottom).
 * R2 flow: RouteMap auto-routes → SelectedGeometry → form → Convex mutation → redirect.
 */
import { createFileRoute, redirect, useNavigate } from '@tanstack/react-router'
import { useMutation } from 'convex/react'
import { useState, useCallback } from 'react'
// eslint-disable-next-line @typescript-eslint/no-explicit-any
import { api as _api } from '../../convex/_generated/api'
const api = _api as any
import { getSession } from '#/lib/session'
import { RouteMap } from '#/components/RouteMap'
import { RouteForm } from '#/components/RouteForm'
import type { SelectedGeometry } from '#/components/RouteMap'
import type { RouteInput } from '#/lib/shared'

export const Route = createFileRoute('/route/new')({
  beforeLoad: async ({ location }) => {
    const session = await getSession()
    if (!session) {
      throw redirect({ to: '/login', search: { redirect: location.href } })
    }
    return { session }
  },
  component: NewRoute,
})

function NewRoute() {
  const navigate = useNavigate()
  const createRoute = useMutation(api.routes.create)
  const [loading, setLoading] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [geometry, setGeometry] = useState<SelectedGeometry | null>(null)

  const handleGeometrySelect = useCallback((geo: SelectedGeometry) => {
    setGeometry(geo)
  }, [])

  const handleSubmit = useCallback(
    async (input: RouteInput) => {
      setLoading(true)
      setSaveError(null)
      try {
        await createRoute({
          ...input,
          // Persist elevation from routing engine (ADR 0002 schema delta)
          ...(geometry?.elevation
            ? {
                elevationGainMeters: geometry.elevation.gainMeters,
                elevationDropMeters: geometry.elevation.dropMeters,
                avgGradePct: geometry.elevation.avgGradePct,
              }
            : {}),
        })
        await navigate({ to: '/mes-routes' })
      } catch (err) {
        setSaveError(
          err instanceof Error ? err.message : 'Erreur lors de l\'enregistrement. Réessayez.',
        )
      } finally {
        setLoading(false)
      }
    },
    [createRoute, navigate, geometry],
  )

  const formGeometry = geometry
    ? { start: geometry.start, end: geometry.end, path: geometry.path }
    : undefined

  return (
    <main className="flex h-[calc(100vh-56px)] flex-col md:flex-row">
      {/* Map: left panel (desktop) / top panel (mobile) */}
      <section className="relative h-72 flex-shrink-0 md:h-full md:flex-1">
        <RouteMap
          routes={[]}
          mode="draw"
          onGeometrySelect={handleGeometrySelect}
        />
      </section>

      {/* Form: right panel (desktop) / bottom panel (mobile) */}
      <section className="flex w-full flex-col overflow-y-auto border-t border-gray-200 p-6 md:w-96 md:border-l md:border-t-0">
        <h1 className="mb-4 text-xl font-bold">Référencer une route</h1>
        <p className="mb-4 text-xs text-gray-500">
          <span className="font-medium text-green-700">D</span> = Départ (haut) ·{' '}
          <span className="font-medium text-red-600">A</span> = Arrivée (bas)
        </p>
        {saveError && (
          <div className="mb-4 rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            ⚠️ {saveError}
          </div>
        )}
        <RouteForm
          geometry={formGeometry}
          onSubmit={handleSubmit}
          loading={loading}
        />
      </section>
    </main>
  )
}
