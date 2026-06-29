import { describe, it, expect } from 'vitest'
import { spliceSubPath, spliceSlopeProfile } from './splice'
import type { LatLng } from '../shared/geo'

// Helpers
const pt = (lat: number, lng: number): LatLng => ({ lat, lng })

// Five-point base path: P0..P4
const PATH5: LatLng[] = [pt(0, 0), pt(1, 1), pt(2, 2), pt(3, 3), pt(4, 4)]
// Slope profile for PATH5 (4 segments)
const SLOPE5 = [0.1, 0.2, 0.3, 0.4]

describe('spliceSubPath', () => {
  it('splices in the middle — keeps flanks intact', () => {
    const sub: LatLng[] = [pt(1, 1), pt(1.5, 1.5), pt(2, 2)]
    const result = spliceSubPath(PATH5, 1, 2, sub)
    expect(result).toEqual([PATH5[0], ...sub, PATH5[3], PATH5[4]])
  })

  it('splices from idxA=0 (start anchor)', () => {
    const sub: LatLng[] = [pt(0, 0), pt(0.5, 0.5), pt(1, 1)]
    const result = spliceSubPath(PATH5, 0, 1, sub)
    expect(result).toEqual([...sub, PATH5[2], PATH5[3], PATH5[4]])
  })

  it('splices to idxB=last (end anchor)', () => {
    const sub: LatLng[] = [pt(3, 3), pt(3.5, 3.5), pt(4, 4)]
    const result = spliceSubPath(PATH5, 3, 4, sub)
    expect(result).toEqual([PATH5[0], PATH5[1], PATH5[2], ...sub])
  })

  it('splices entire path (idxA=0, idxB=last)', () => {
    const sub: LatLng[] = [pt(0, 0), pt(2, 2), pt(4, 4)]
    const result = spliceSubPath(PATH5, 0, 4, sub)
    expect(result).toEqual(sub)
  })

  it('result length = (idxA) + subPath.length + (N - 1 - idxB)', () => {
    const sub: LatLng[] = [pt(1, 1), pt(1.2, 1.2), pt(1.8, 1.8), pt(2, 2)]
    const result = spliceSubPath(PATH5, 1, 2, sub)
    expect(result.length).toBe(1 + 4 + 2) // 1 kept before + 4 sub + 2 kept after
  })

  it('preserves original array (no mutation)', () => {
    const original = [pt(0, 0), pt(1, 1), pt(2, 2)]
    const snap = original.map((p) => ({ ...p }))
    spliceSubPath(original, 0, 1, [pt(0, 0), pt(0.5, 0.5), pt(1, 1)])
    expect(original).toEqual(snap)
  })
})

describe('spliceSlopeProfile', () => {
  it('splices in the middle — segments outside the range stay intact', () => {
    // Replace points[1..2] → sub slope covers 1 new segment (idxA=1, idxB=2)
    const sub = [0.25]
    const result = spliceSlopeProfile(SLOPE5, 1, 2, sub)
    // orig[0..0] + sub + orig[2..3] → [0.1, 0.25, 0.3, 0.4]
    expect(result).toEqual([0.1, 0.25, 0.3, 0.4])
  })

  it('splices from idxA=0', () => {
    const sub = [0.15, 0.25]
    const result = spliceSlopeProfile(SLOPE5, 0, 2, sub)
    // orig[0..-1] + sub + orig[2..3] → [0.15, 0.25, 0.3, 0.4]
    expect(result).toEqual([0.15, 0.25, 0.3, 0.4])
  })

  it('splices to idxB=last-point (idxB=4 on a 5-point path, slope orig has 4 entries)', () => {
    const sub = [0.35, 0.45]
    // idxB = 4 = last point index; orig.slice(4) = [] (orig has indices 0..3)
    const result = spliceSlopeProfile(SLOPE5, 2, 4, sub)
    // orig[0..1] + sub + [] → [0.1, 0.2, 0.35, 0.45]
    expect(result).toEqual([0.1, 0.2, 0.35, 0.45])
  })

  it('splices entire profile (idxA=0, idxB=last-point)', () => {
    const sub = [0.9, 0.8, 0.7]
    const result = spliceSlopeProfile(SLOPE5, 0, 4, sub)
    expect(result).toEqual(sub)
  })

  it('result length = new path segments (spliceSubPath length - 1)', () => {
    // splice PATH5[1..2] with a 4-point sub → new path has 7 points → 6 segments
    const sub3segs = [0.11, 0.12, 0.13]
    const result = spliceSlopeProfile(SLOPE5, 1, 2, sub3segs)
    // orig[0..0] (1) + sub (3) + orig[2..3] (2) = 6 segments
    expect(result.length).toBe(1 + 3 + 2)
  })

  it('preserves original array (no mutation)', () => {
    const orig = [0.1, 0.2, 0.3]
    const snap = [...orig]
    spliceSlopeProfile(orig, 0, 1, [0.15])
    expect(orig).toEqual(snap)
  })
})
