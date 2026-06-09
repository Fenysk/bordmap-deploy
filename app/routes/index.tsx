import { createFileRoute } from '@tanstack/react-router'
import { RouteMap } from '#/components/RouteMap'

export const Route = createFileRoute('/')({ component: Home })

function Home() {
  return (
    <main className="mx-auto max-w-3xl p-6">
      <h1 className="text-3xl font-bold">Bordmap</h1>
      <p className="mt-2 text-gray-600">
        Référence et découvre les meilleures routes Freebord, sur une carte
        interactive.
      </p>
      <div className="mt-6 h-80">
        {/* B3 wires real routes from `routes.listInBounds` in L4. */}
        <RouteMap routes={[]} mode="view" />
      </div>
    </main>
  )
}
