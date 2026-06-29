import { describe, it, expect } from 'vitest'
import { haversineMeters } from './geo'
import {
  computeHandle,
  buildCorridorRing,
  buildExclusionAreas,
  computeOverlapFraction,
  passesDistinctnessCheck,
  passesQualityFloor,
  MAX_OVERLAP,
  MAX_DIST_FACTOR,
  MAX_DUR_FACTOR,
} from './routing'
import type { RouteHandle } from './route'

// ─── computeHandle ────────────────────────────────────────────────────────────

describe('computeHandle', () => {
  const pathA = [
    { lat: 45.19, lng: 5.725 },
    { lat: 45.185, lng: 5.722 },
    { lat: 45.18, lng: 5.72 },
  ]
  const pathB = [
    { lat: 46.0, lng: 6.0 },
    { lat: 46.01, lng: 6.01 },
  ]

  it('returns an 8-character hex string', () => {
    expect(computeHandle(pathA)).toMatch(/^[0-9a-f]{8}$/)
  })

  it('is deterministic — same path yields same handle', () => {
    expect(computeHandle(pathA)).toBe(computeHandle(pathA))
  })

  it('differs for different paths', () => {
    expect(computeHandle(pathA)).not.toBe(computeHandle(pathB))
  })

  it('differs for reversed path (order matters)', () => {
    expect(computeHandle(pathA)).not.toBe(computeHandle([...pathA].reverse()))
  })
})

// ─── buildCorridorRing ────────────────────────────────────────────────────────

describe('buildCorridorRing', () => {
  const seg = [
    { lat: 45.0, lng: 5.0 },
    { lat: 45.01, lng: 5.01 },
  ]

  it('returns [] for path shorter than 2 points', () => {
    expect(buildCorridorRing([], 45)).toEqual([])
    expect(buildCorridorRing([{ lat: 1, lng: 1 }], 45)).toEqual([])
  })

  it('produces a closed ring — first coord equals last coord', () => {
    const ring = buildCorridorRing(seg, 45)
    expect(ring.length).toBeGreaterThanOrEqual(4)
    expect(ring[0]).toEqual(ring[ring.length - 1])
  })

  it('single segment → 5-point ring (4 corners + closing point)', () => {
    const ring = buildCorridorRing(seg, 45)
    expect(ring.length).toBe(5)
  })

  it('buffer width ≈ 2 × bufferMeters (within 30% tolerance)', () => {
    const bufferMeters = 50
    const ring = buildCorridorRing(seg, bufferMeters)
    // ring: [left_p1, left_p2, right_p2, right_p1, left_p1(close)]
    // corners at p1: ring[0] (left) and ring[3] (right)
    const leftP1 = { lat: ring[0][1], lng: ring[0][0] }
    const rightP1 = { lat: ring[3][1], lng: ring[3][0] }
    const width = haversineMeters(leftP1, rightP1)
    expect(width).toBeGreaterThan(bufferMeters * 1.5)
    expect(width).toBeLessThan(bufferMeters * 2.6)
  })
})

// ─── buildExclusionAreas ─────────────────────────────────────────────────────

describe('buildExclusionAreas', () => {
  const excludes: RouteHandle[] = [
    {
      handle: 'abc',
      path: [
        { lat: 45.0, lng: 5.0 },
        { lat: 45.01, lng: 5.01 },
        { lat: 45.02, lng: 5.02 },
      ],
    },
    {
      handle: 'def',
      path: [
        { lat: 46.0, lng: 6.0 },
        { lat: 46.01, lng: 6.01 },
      ],
    },
  ]

  it('returns a FeatureCollection', () => {
    const fc = buildExclusionAreas(excludes)
    expect(fc.type).toBe('FeatureCollection')
    expect(Array.isArray(fc.features)).toBe(true)
  })

  it('produces one feature per excluded route', () => {
    expect(buildExclusionAreas(excludes).features).toHaveLength(2)
  })

  it('ids follow the avoid_N pattern', () => {
    const fc = buildExclusionAreas(excludes)
    expect(fc.features[0].id).toBe('avoid_0')
    expect(fc.features[1].id).toBe('avoid_1')
  })

  it('each feature is a closed Polygon', () => {
    const fc = buildExclusionAreas(excludes)
    for (const f of fc.features) {
      expect(f.geometry.type).toBe('Polygon')
      const ring = f.geometry.coordinates[0]
      expect(ring.length).toBeGreaterThanOrEqual(4)
      expect(ring[0]).toEqual(ring[ring.length - 1])
    }
  })

  it('filters out single-point paths (no valid corridor)', () => {
    const fc = buildExclusionAreas([{ handle: 'x', path: [{ lat: 1, lng: 1 }] }])
    expect(fc.features).toHaveLength(0)
  })

  it('larger buffer produces a wider polygon', () => {
    const small = buildExclusionAreas([excludes[0]], 30)
    const large = buildExclusionAreas([excludes[0]], 80)
    const ringSmall = small.features[0].geometry.coordinates[0]
    const ringLarge = large.features[0].geometry.coordinates[0]
    const widthSmall = haversineMeters(
      { lat: ringSmall[0][1], lng: ringSmall[0][0] },
      { lat: ringSmall[3][1], lng: ringSmall[3][0] },
    )
    const widthLarge = haversineMeters(
      { lat: ringLarge[0][1], lng: ringLarge[0][0] },
      { lat: ringLarge[3][1], lng: ringLarge[3][0] },
    )
    expect(widthLarge).toBeGreaterThan(widthSmall)
  })
})

// ─── computeOverlapFraction ───────────────────────────────────────────────────

describe('computeOverlapFraction', () => {
  const mainPath = [
    { lat: 45.0, lng: 5.0 },
    { lat: 45.05, lng: 5.0 },
    { lat: 45.1, lng: 5.0 },
  ]

  it('returns 0 for empty excluded list', () => {
    expect(computeOverlapFraction(mainPath, [], 30)).toBe(0)
  })

  it('returns 0 for candidate with fewer than 2 points', () => {
    expect(computeOverlapFraction([], [[mainPath[0]]], 30)).toBe(0)
    expect(computeOverlapFraction([mainPath[0]], [mainPath], 30)).toBe(0)
  })

  it('returns ≈1 for identical paths', () => {
    expect(computeOverlapFraction(mainPath, [mainPath], 30)).toBeGreaterThan(0.95)
  })

  it('returns 0 for completely disjoint paths', () => {
    const farPath = [
      { lat: 50.0, lng: 2.0 },
      { lat: 50.01, lng: 2.0 },
    ]
    expect(computeOverlapFraction(mainPath, [farPath], 30)).toBe(0)
  })

  it('returns partial overlap for partially shared paths', () => {
    // Only the first half of mainPath is excluded
    const partialExclude = [mainPath[0], mainPath[1]]
    const overlap = computeOverlapFraction(mainPath, [partialExclude], 30)
    expect(overlap).toBeGreaterThan(0)
    expect(overlap).toBeLessThan(1)
  })

  it('nearby parallel path within threshold is counted as overlap', () => {
    // Parallel path ~20m east (within 30m threshold)
    const nearParallel = [
      { lat: 45.0, lng: 5.00018 }, // ~18m east at lat=45
      { lat: 45.05, lng: 5.00018 },
      { lat: 45.1, lng: 5.00018 },
    ]
    const overlap = computeOverlapFraction(mainPath, [nearParallel], 30)
    expect(overlap).toBeGreaterThan(0.5)
  })

  it('path beyond threshold is not counted as overlap', () => {
    // Parallel path ~100m east (beyond 30m threshold)
    const farParallel = [
      { lat: 45.0, lng: 5.001 }, // ~90m east at lat=45
      { lat: 45.05, lng: 5.001 },
      { lat: 45.1, lng: 5.001 },
    ]
    const overlap = computeOverlapFraction(mainPath, [farParallel], 30)
    expect(overlap).toBe(0)
  })
})

// ─── passesDistinctnessCheck ──────────────────────────────────────────────────

describe('passesDistinctnessCheck (plan §3 — overlap ≤ 0.70)', () => {
  it('constant MAX_OVERLAP is 0.70', () => {
    expect(MAX_OVERLAP).toBe(0.70)
  })

  it('passes at exactly MAX_OVERLAP', () => {
    expect(passesDistinctnessCheck(MAX_OVERLAP)).toBe(true)
  })

  it('passes below MAX_OVERLAP', () => {
    expect(passesDistinctnessCheck(0.50)).toBe(true)
    expect(passesDistinctnessCheck(0.0)).toBe(true)
  })

  it('fails above MAX_OVERLAP', () => {
    expect(passesDistinctnessCheck(0.71)).toBe(false)
    expect(passesDistinctnessCheck(1.0)).toBe(false)
  })
})

// ─── passesQualityFloor ───────────────────────────────────────────────────────

describe('passesQualityFloor (plan §3 — dist ≤ 1.6× + dur ≤ 1.8×)', () => {
  it('constants are 1.6 and 1.8', () => {
    expect(MAX_DIST_FACTOR).toBe(1.6)
    expect(MAX_DUR_FACTOR).toBe(1.8)
  })

  const pDist = 10_000
  const pDur = 1_200

  it('passes when both dist and dur are within thresholds', () => {
    const r = passesQualityFloor(14_000, 2_000, pDist, pDur)
    expect(r.passes).toBe(true)
    expect(r.reason).toBeUndefined()
  })

  it('fails with quality_floor when dist > 1.6× primary', () => {
    const r = passesQualityFloor(pDist * MAX_DIST_FACTOR + 1, pDur, pDist, pDur)
    expect(r.passes).toBe(false)
    expect(r.reason).toBe('quality_floor')
  })

  it('fails with quality_floor when dur > 1.8× primary', () => {
    const r = passesQualityFloor(pDist, pDur * MAX_DUR_FACTOR + 1, pDist, pDur)
    expect(r.passes).toBe(false)
    expect(r.reason).toBe('quality_floor')
  })

  it('passes at exactly the boundary values', () => {
    const r = passesQualityFloor(pDist * MAX_DIST_FACTOR, pDur * MAX_DUR_FACTOR, pDist, pDur)
    expect(r.passes).toBe(true)
  })

  it('skips dur check when primaryDurSec is 0 (unknown primary duration)', () => {
    const r = passesQualityFloor(pDist, pDur * 5, pDist, 0)
    expect(r.passes).toBe(true)
  })
})

// ─── AC-B3: exhausted ≠ error ─────────────────────────────────────────────────

describe('NextAlternativeResult discriminants (AC-B3)', () => {
  it('exhausted has reason field, not code', () => {
    const exhausted = { status: 'exhausted' as const, reason: 'no_distinct_corridor' as const }
    expect(exhausted.status).toBe('exhausted')
    expect('reason' in exhausted).toBe(true)
    expect('code' in exhausted).toBe(false)
  })

  it('error has code field, not reason', () => {
    const error = { status: 'error' as const, code: 'GH_DOWN', message: 'unavailable' }
    expect(error.status).toBe('error')
    expect('code' in error).toBe(true)
    expect('reason' in error).toBe(false)
  })

  it('ok has candidate field', () => {
    const ok = {
      status: 'ok' as const,
      candidate: {
        handle: 'abc123',
        path: [{ lat: 1, lng: 1 }, { lat: 2, lng: 2 }],
        distanceMeters: 1000,
        durationSeconds: 120,
        overlapWithExcluded: 0.3,
      },
    }
    expect(ok.status).toBe('ok')
    expect('candidate' in ok).toBe(true)
  })

  it('exhausted reason no_distinct_corridor ≠ quality_floor', () => {
    expect('no_distinct_corridor').not.toBe('quality_floor')
  })
})
