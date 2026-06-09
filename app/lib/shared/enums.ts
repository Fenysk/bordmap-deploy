/**
 * Shared enums for the Bordmap "route" model (plan §2 of FEN-341).
 *
 * Single source of truth for the frontend (`RouteForm`, `RouteDetailCard`) and
 * the Convex backend (`routes` table / validators added in L2). Each enum is a
 * `const` tuple so we get both a runtime list (for `<select>` options, seeds,
 * validation) and a derived union type.
 */

export const DIFFICULTY = ['debutant', 'intermediaire', 'confirme', 'expert'] as const
export type Difficulty = (typeof DIFFICULTY)[number]

export const SURFACE_QUALITY = ['lisse', 'correct', 'degrade'] as const
export type SurfaceQuality = (typeof SURFACE_QUALITY)[number]

export const SLOPE = ['douce', 'moyenne', 'raide'] as const
export type Slope = (typeof SLOPE)[number]

export const TRAFFIC_LEVEL = ['aucun', 'faible', 'modere', 'eleve'] as const
export type TrafficLevel = (typeof TRAFFIC_LEVEL)[number]

export const TERRAIN_TYPE = ['rue', 'montagne', 'parking'] as const
export type TerrainType = (typeof TERRAIN_TYPE)[number]

/**
 * Difficulty → colour, consumed by `<RouteMap>` to colour each line and by
 * `<RouteDetailCard>` for the difficulty badge (plan §3). Kept here so map and
 * card never drift apart. Values are colour-blind-friendly-ish greens→reds.
 */
export const DIFFICULTY_COLOR: Record<Difficulty, string> = {
  debutant: '#2e7d32', // green
  intermediaire: '#1565c0', // blue
  confirme: '#ef6c00', // orange
  expert: '#c62828', // red
}

/** Runtime guard — handy for seed scripts and mutation validation in L2. */
export function isDifficulty(value: unknown): value is Difficulty {
  return typeof value === 'string' && (DIFFICULTY as readonly string[]).includes(value)
}
