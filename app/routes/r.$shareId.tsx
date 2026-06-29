import { createFileRoute, Link } from '@tanstack/react-router'
import { useQuery } from 'convex/react'
// eslint-disable-next-line @typescript-eslint/no-explicit-any
import { api } from '../../convex/_generated/api'
import RouteMap from '#/components/RouteMap'

const _api = api as any // eslint-disable-line @typescript-eslint/no-explicit-any

export const Route = createFileRoute('/r/$shareId')({ component: SharePage })

function SharePage() {
  const { shareId } = Route.useParams()

  const route = useQuery(_api.routes.getByShareId, { shareId }) as
    | null
    | undefined
    | {
        shareId: string
        start: { lat: number; lng: number }
        end: { lat: number; lng: number }
        path: Array<{ lat: number; lng: number }>
        distanceMeters: number
        createdAt: number
      }

  if (route === undefined) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <p className="text-sm text-gray-400">Chargement…</p>
      </div>
    )
  }

  if (route === null) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-4 p-8">
        <p className="text-base font-medium text-gray-700">Lien introuvable</p>
        <p className="text-sm text-gray-400">
          Cette route n&apos;existe pas ou a été supprimée.
        </p>
        <Link to="/" className="text-sm text-blue-600 hover:underline">
          Retour à la carte
        </Link>
      </div>
    )
  }

  const km = (route.distanceMeters / 1000).toFixed(1)
  const fitPoints = [route.start, ...route.path, route.end]

  return (
    <div className="flex min-h-screen flex-col">
      <header className="flex items-center justify-between border-b border-gray-200 bg-white px-4 py-3">
        <Link to="/" className="text-sm font-semibold text-gray-800 hover:underline">
          Bordmap
        </Link>
        <span className="text-sm text-gray-500">{km} km</span>
      </header>

      <main className="flex flex-1">
        <RouteMap
          start={route.start}
          end={route.end}
          routePath={route.path}
          onMapClick={() => {}}
          fitTo={fitPoints}
        />
      </main>
    </div>
  )
}
