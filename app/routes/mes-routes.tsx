/**
 * /mes-routes — auth-gated list of the current user's routes.
 * Queries routes.listMine via Convex (requires an authenticated session).
 */
import { createFileRoute, redirect, Link } from '@tanstack/react-router'
import { useQuery } from 'convex/react'
// eslint-disable-next-line @typescript-eslint/no-explicit-any
import { api as _api } from '../../convex/_generated/api'
const api = _api as any
import { getSession } from '#/lib/session'
import { RouteDetailCard } from '#/components/RouteDetailCard'
import { DIFFICULTY_COLOR } from '#/lib/shared'

export const Route = createFileRoute('/mes-routes')({
  beforeLoad: async ({ location }) => {
    const session = await getSession()
    if (!session) {
      throw redirect({ to: '/login', search: { redirect: location.href } })
    }
    return { session }
  },
  component: MesRoutes,
})

function MesRoutes() {
  const { session } = Route.useRouteContext()
  const routes = useQuery(api.routes.listMine)

  return (
    <main className="mx-auto max-w-3xl p-6">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-bold">Mes routes</h1>
        <Link
          to="/route/new"
          className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
        >
          + Référencer une route
        </Link>
      </div>

      <p className="mb-4 text-sm text-gray-500">
        Connecté en tant que <strong>{session.displayName || session.email}</strong>
      </p>

      {/* undefined = Convex loading; null = JWT not yet established (transient) */}
      {(routes === undefined || routes === null) && (
        <div className="space-y-3">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-20 animate-pulse rounded-lg bg-gray-100" />
          ))}
        </div>
      )}

      {routes !== null && routes !== undefined && routes.length === 0 && (
        <div className="rounded-lg border border-dashed border-gray-300 p-8 text-center">
          <p className="text-gray-500">Vous n'avez pas encore référencé de route.</p>
          <Link
            to="/route/new"
            className="mt-4 inline-block rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
          >
            Référencer ma première route
          </Link>
        </div>
      )}

      {routes !== null && routes !== undefined && routes.length > 0 && (
        <ul className="space-y-3">
          {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
          {(routes as any[]).map((r) => (
            <li key={r._id}>
              <div className="flex items-center gap-2 rounded-t-lg border border-b-0 border-gray-200 px-4 py-2">
                <span
                  className="h-3 w-3 rounded-full"
                  style={{ backgroundColor: DIFFICULTY_COLOR[r.difficulty as keyof typeof DIFFICULTY_COLOR] }}
                />
                <span className="text-xs text-gray-500 capitalize">{r.difficulty}</span>
                <span className="ml-auto text-xs text-gray-400">
                  {new Date(r.createdAt).toLocaleDateString('fr-FR')}
                </span>
              </div>
              <RouteDetailCard route={r} />
            </li>
          ))}
        </ul>
      )}
    </main>
  )
}
