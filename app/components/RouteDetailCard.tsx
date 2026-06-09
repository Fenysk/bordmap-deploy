import type { Route } from '#/lib/shared'
import { DIFFICULTY_COLOR } from '#/lib/shared'
import { SafetyBanner } from '#/components/SafetyBanner'

/**
 * Rich detail card for B3 (plan §3): every structured attribute + derived
 * length + safety warnings. L0 ships the contract + a minimal render; L4
 * builds the full card. Safety wording (L6) is layered on top.
 */
export interface RouteDetailCardProps {
  route: Route
}

export function RouteDetailCard({ route }: RouteDetailCardProps) {
  return (
    <article data-testid="route-detail-card" className="rounded border p-4">
      <header className="flex items-center justify-between">
        <h2 className="text-xl font-semibold">{route.name}</h2>
        <span
          className="rounded px-2 py-0.5 text-xs text-white"
          style={{ backgroundColor: DIFFICULTY_COLOR[route.difficulty] }}
        >
          {route.difficulty}
        </span>
      </header>
      <p className="mt-2 text-sm text-gray-600">
        {Math.round(route.lengthMeters)} m
        {route.spotName ? ` · ${route.spotName}` : ''}
      </p>
      <div className="mt-3">
        <SafetyBanner variant="compact" />
      </div>
    </article>
  )
}

export default RouteDetailCard
