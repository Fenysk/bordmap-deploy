/**
 * Minimal-input form for B2 (plan §3).
 * Required first: name + difficulty. Optional rich fields collapsed in a <details>.
 * Calls props.onSubmit — the parent owns the Convex mutation.
 */
import { useState } from 'react'
import { DIFFICULTY, SURFACE_QUALITY, SLOPE, TRAFFIC_LEVEL, TERRAIN_TYPE } from '#/lib/shared'
import type { RouteInput, LatLng } from '#/lib/shared'

export interface RouteFormProps {
  geometry?: { start: LatLng; end: LatLng; path?: Array<LatLng> }
  onSubmit: (input: RouteInput) => void | Promise<void>
  defaultValues?: Partial<RouteInput>
  loading?: boolean
}

const DIFFICULTY_LABEL: Record<string, string> = {
  debutant: 'Débutant',
  intermediaire: 'Intermédiaire',
  confirme: 'Confirmé',
  expert: 'Expert',
}

const SURFACE_LABEL: Record<string, string> = {
  lisse: 'Lisse',
  correct: 'Correct',
  degrade: 'Dégradé',
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

export function RouteForm({ geometry, onSubmit, defaultValues, loading }: RouteFormProps) {
  const [name, setName] = useState(defaultValues?.name ?? '')
  const [difficulty, setDifficulty] = useState<(typeof DIFFICULTY)[number]>(
    defaultValues?.difficulty ?? 'debutant',
  )
  const [spotName, setSpotName] = useState(defaultValues?.spotName ?? '')
  const [surfaceQuality, setSurfaceQuality] = useState(defaultValues?.surfaceQuality ?? '')
  const [slope, setSlope] = useState(defaultValues?.slope ?? '')
  const [trafficLevel, setTrafficLevel] = useState(defaultValues?.trafficLevel ?? '')
  const [terrainType, setTerrainType] = useState(defaultValues?.terrainType ?? '')
  const [description, setDescription] = useState(defaultValues?.description ?? '')
  const [error, setError] = useState<string | null>(null)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    if (!geometry) {
      setError('Posez d\'abord le départ et l\'arrivée sur la carte.')
      return
    }
    if (!name.trim()) {
      setError('Le nom de la route est requis.')
      return
    }

    const input: RouteInput = {
      name: name.trim(),
      difficulty,
      start: geometry.start,
      end: geometry.end,
      path: geometry.path,
      ...(spotName.trim() ? { spotName: spotName.trim() } : {}),
      ...(surfaceQuality ? { surfaceQuality: surfaceQuality as any } : {}),
      ...(slope ? { slope: slope as any } : {}),
      ...(trafficLevel ? { trafficLevel: trafficLevel as any } : {}),
      ...(terrainType ? { terrainType: terrainType as any } : {}),
      ...(description.trim() ? { description: description.trim() } : {}),
    }

    try {
      await onSubmit(input)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Une erreur est survenue.')
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      {/* Required fields */}
      <div>
        <label htmlFor="route-name" className="block text-sm font-medium text-gray-700">
          Nom de la route <span className="text-red-500">*</span>
        </label>
        <input
          id="route-name"
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="ex. Descente des Pins"
          required
          className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
        />
      </div>

      <div>
        <label htmlFor="route-difficulty" className="block text-sm font-medium text-gray-700">
          Difficulté <span className="text-red-500">*</span>
        </label>
        <select
          id="route-difficulty"
          value={difficulty}
          onChange={(e) => setDifficulty(e.target.value as typeof difficulty)}
          className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
        >
          {DIFFICULTY.map((d) => (
            <option key={d} value={d}>
              {DIFFICULTY_LABEL[d]}
            </option>
          ))}
        </select>
      </div>

      {/* Geometry status */}
      {geometry ? (
        <p className="rounded-md bg-green-50 px-3 py-2 text-sm text-green-700">
          ✓ Départ + arrivée confirmés sur la carte.
        </p>
      ) : (
        <p className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-700">
          Posez le départ (D) puis l'arrivée (A) sur la carte ci-contre.
        </p>
      )}

      {/* Optional rich fields */}
      <details className="group">
        <summary className="cursor-pointer select-none text-sm font-medium text-blue-600 hover:text-blue-800">
          + Informations optionnelles
        </summary>
        <div className="mt-3 space-y-3 rounded-md border border-gray-200 p-3">
          <div>
            <label htmlFor="route-spot" className="block text-sm font-medium text-gray-700">
              Nom de la descente (spot)
            </label>
            <input
              id="route-spot"
              type="text"
              value={spotName}
              onChange={(e) => setSpotName(e.target.value)}
              placeholder="ex. Col de la Faye"
              className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor="route-surface" className="block text-sm font-medium text-gray-700">
                Revêtement
              </label>
              <select
                id="route-surface"
                value={surfaceQuality}
                onChange={(e) => setSurfaceQuality(e.target.value)}
                className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
              >
                <option value="">—</option>
                {SURFACE_QUALITY.map((s) => (
                  <option key={s} value={s}>{SURFACE_LABEL[s]}</option>
                ))}
              </select>
            </div>

            <div>
              <label htmlFor="route-slope" className="block text-sm font-medium text-gray-700">
                Pente
              </label>
              <select
                id="route-slope"
                value={slope}
                onChange={(e) => setSlope(e.target.value)}
                className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
              >
                <option value="">—</option>
                {SLOPE.map((s) => (
                  <option key={s} value={s}>{SLOPE_LABEL[s]}</option>
                ))}
              </select>
            </div>

            <div>
              <label htmlFor="route-traffic" className="block text-sm font-medium text-gray-700">
                Trafic
              </label>
              <select
                id="route-traffic"
                value={trafficLevel}
                onChange={(e) => setTrafficLevel(e.target.value)}
                className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
              >
                <option value="">—</option>
                {TRAFFIC_LEVEL.map((t) => (
                  <option key={t} value={t}>{TRAFFIC_LABEL[t]}</option>
                ))}
              </select>
            </div>

            <div>
              <label htmlFor="route-terrain" className="block text-sm font-medium text-gray-700">
                Type de terrain
              </label>
              <select
                id="route-terrain"
                value={terrainType}
                onChange={(e) => setTerrainType(e.target.value)}
                className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
              >
                <option value="">—</option>
                {TERRAIN_TYPE.map((t) => (
                  <option key={t} value={t}>{TERRAIN_LABEL[t]}</option>
                ))}
              </select>
            </div>
          </div>

          <div>
            <label htmlFor="route-desc" className="block text-sm font-medium text-gray-700">
              Description
            </label>
            <textarea
              id="route-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
              placeholder="Conditions, conseils, remarques…"
              className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
          </div>
        </div>
      </details>

      {error && (
        <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>
      )}

      <button
        type="submit"
        disabled={loading || !geometry}
        className="w-full rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {loading ? 'Enregistrement…' : 'Référencer la route'}
      </button>
    </form>
  )
}

export default RouteForm
