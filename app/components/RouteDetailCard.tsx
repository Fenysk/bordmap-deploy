import type { Route } from '#/lib/shared'
import { DIFFICULTY_COLOR } from '#/lib/shared'
import { SafetyBanner } from '#/components/SafetyBanner'

const DIFFICULTY_LABEL: Record<string, string> = {
  debutant: 'Débutant',
  intermediaire: 'Intermédiaire',
  confirme: 'Confirmé',
  expert: 'Expert',
}

const SURFACE_LABEL: Record<string, string> = {
  lisse: 'Lisse',
  correct: 'Correcte',
  degrade: 'Dégradée',
}

const SLOPE_LABEL: Record<string, string> = {
  douce: 'Douce',
  moyenne: 'Moyenne',
  raide: 'Raide',
}

const TRAFFIC_LABEL: Record<string, string> = {
  aucun: 'Aucun',
  faible: 'Faible',
  modere: 'Modéré',
  eleve: 'Élevé',
}

const TERRAIN_LABEL: Record<string, string> = {
  rue: 'Rue',
  montagne: 'Montagne',
  parking: 'Parking',
}

function fmtDistance(m: number) {
  return m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`
}

export interface RouteDetailCardProps {
  route: Route
}

export function RouteDetailCard({ route }: RouteDetailCardProps) {
  const hasRichAttrs =
    route.terrainType || route.slope || route.surfaceQuality || route.trafficLevel

  return (
    <article data-testid="route-detail-card" className="space-y-4 rounded-lg border border-gray-200 bg-white p-4">
      {/* Header */}
      <header className="flex items-start gap-3">
        <div className="flex-1">
          <h2 className="text-xl font-semibold text-gray-900">{route.name}</h2>
          {route.spotName && (
            <p className="mt-0.5 text-sm text-gray-500">{route.spotName}</p>
          )}
        </div>
        <span
          className="mt-0.5 flex-shrink-0 rounded px-2 py-0.5 text-xs font-medium text-white"
          style={{ backgroundColor: DIFFICULTY_COLOR[route.difficulty] }}
        >
          {DIFFICULTY_LABEL[route.difficulty] ?? route.difficulty}
        </span>
      </header>

      {/* Key metrics */}
      <dl className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-3">
        <div className="rounded-lg bg-gray-50 px-3 py-2">
          <dt className="text-xs text-gray-500">Distance</dt>
          <dd className="font-medium">{fmtDistance(route.lengthMeters)}</dd>
        </div>
        {route.elevationGainMeters !== undefined &&
          route.elevationDropMeters !== undefined && (
            <div className="rounded-lg bg-gray-50 px-3 py-2">
              <dt className="text-xs text-gray-500">Dénivelé</dt>
              <dd className="font-medium">
                D+ {route.elevationGainMeters} m · D− {route.elevationDropMeters} m
              </dd>
            </div>
          )}
        {route.avgGradePct !== undefined && (
          <div className="rounded-lg bg-gray-50 px-3 py-2">
            <dt className="text-xs text-gray-500">Pente moy.</dt>
            <dd className="font-medium">{route.avgGradePct.toFixed(1)} %</dd>
          </div>
        )}
      </dl>

      {/* Rich attributes */}
      {hasRichAttrs && (
        <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
          {route.terrainType && (
            <div className="flex justify-between gap-2">
              <dt className="text-gray-500">Terrain</dt>
              <dd className="font-medium">
                {TERRAIN_LABEL[route.terrainType] ?? route.terrainType}
              </dd>
            </div>
          )}
          {route.slope && (
            <div className="flex justify-between gap-2">
              <dt className="text-gray-500">Pente</dt>
              <dd className="font-medium">
                {SLOPE_LABEL[route.slope] ?? route.slope}
              </dd>
            </div>
          )}
          {route.surfaceQuality && (
            <div className="flex justify-between gap-2">
              <dt className="text-gray-500">Surface</dt>
              <dd className="font-medium">
                {SURFACE_LABEL[route.surfaceQuality] ?? route.surfaceQuality}
              </dd>
            </div>
          )}
          {route.trafficLevel && (
            <div className="flex justify-between gap-2">
              <dt className="text-gray-500">Trafic</dt>
              <dd className="font-medium">
                {TRAFFIC_LABEL[route.trafficLevel] ?? route.trafficLevel}
              </dd>
            </div>
          )}
        </dl>
      )}

      {/* Hazards */}
      {route.hazards && route.hazards.length > 0 && (
        <div>
          <p className="mb-1.5 text-xs text-gray-500">Risques signalés</p>
          <div className="flex flex-wrap gap-1.5">
            {route.hazards.map((h) => (
              <span
                key={h}
                className="rounded border border-orange-200 bg-orange-50 px-2 py-0.5 text-xs text-orange-700"
              >
                {h}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Description */}
      {route.description && (
        <p className="text-sm leading-relaxed text-gray-700">{route.description}</p>
      )}

      {/* Safety */}
      <SafetyBanner variant="compact" />
    </article>
  )
}

export default RouteDetailCard
