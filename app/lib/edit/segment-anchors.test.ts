import { describe, it, expect } from 'vitest'
import { findAnchorWindow } from './segment-anchors'
import type { AnchorSelection } from './segment-anchors'

// Straight north-going path: 5 vertices spaced ~111 m apart (0.001° lat ≈ 111 m).
const PATH5 = [
  { lat: 45.0000, lng: 4.8500 }, // idx 0
  { lat: 45.0010, lng: 4.8500 }, // idx 1
  { lat: 45.0020, lng: 4.8500 }, // idx 2  (≈ midpoint)
  { lat: 45.0030, lng: 4.8500 }, // idx 3
  { lat: 45.0040, lng: 4.8500 }, // idx 4
]

function invariants(res: AnchorSelection, path: typeof PATH5) {
  expect(res.idxA).toBeLessThan(res.idxB)
  expect(res.anchorA).toEqual(path[res.idxA])
  expect(res.anchorB).toEqual(path[res.idxB])
  expect(res.rejectedSubPath).toHaveLength(res.idxB - res.idxA + 1)
  expect(res.rejectedSubPath[0]).toEqual(res.anchorA)
  expect(res.rejectedSubPath[res.rejectedSubPath.length - 1]).toEqual(res.anchorB)
}

describe('findAnchorWindow', () => {
  it('returns null for an empty path', () => {
    expect(findAnchorWindow([], { lat: 45, lng: 4.85 }, 200)).toBeNull()
  })

  it('returns null for a single-point path', () => {
    expect(findAnchorWindow([{ lat: 45, lng: 4.85 }], { lat: 45, lng: 4.85 }, 200)).toBeNull()
  })

  it('returns null when tap is too far from the line (AC-TACTILE)', () => {
    // ~500 m east of PATH5 — well beyond the 75 m tolerance
    const tap = { lat: 45.0020, lng: 4.8550 }
    expect(findAnchorWindow(PATH5, tap, 200)).toBeNull()
  })

  it('nominal — tap at midpoint, halfWindowM=100 → idxA=1, idxB=3', () => {
    // tap exactly at path[2]; segments 1→2 and 2→3 both have dist=0; segment 1→2 wins (first found)
    // backDist = 1.0 * ~111 ≥ 100 → idxA stays at 1
    // fwdDist = 0 < 100 → walk to idx 3 (fwdDist += ~111 ≥ 100)
    const tap = { lat: 45.0020, lng: 4.8500 }
    const res = findAnchorWindow(PATH5, tap, 100)
    expect(res).not.toBeNull()
    invariants(res!, PATH5)
    expect(res!.idxA).toBe(1)
    expect(res!.idxB).toBe(3)
  })

  it('large halfWindowM clamps to path ends (idxA=0, idxB=4)', () => {
    const tap = { lat: 45.0020, lng: 4.8500 }
    const res = findAnchorWindow(PATH5, tap, 10_000)
    expect(res).not.toBeNull()
    invariants(res!, PATH5)
    expect(res!.idxA).toBe(0)
    expect(res!.idxB).toBe(PATH5.length - 1)
  })

  it('tap close to path[0] — idxA clamps to 0', () => {
    // tap slightly east of path[0] (within 75 m), small halfWindowM
    const tap = { lat: 45.0000, lng: 4.8504 } // ~35 m east
    const res = findAnchorWindow(PATH5, tap, 50)
    expect(res).not.toBeNull()
    invariants(res!, PATH5)
    expect(res!.idxA).toBe(0) // cannot walk further back
  })

  it('tap close to path[4] — idxB clamps to path.length-1', () => {
    const tap = { lat: 45.0040, lng: 4.8500 } // exactly at last vertex
    const res = findAnchorWindow(PATH5, tap, 50)
    expect(res).not.toBeNull()
    invariants(res!, PATH5)
    expect(res!.idxB).toBe(PATH5.length - 1)
  })

  it('two-point path — tap on the single segment returns a selection', () => {
    const path = [
      { lat: 45.0000, lng: 4.8500 },
      { lat: 45.0010, lng: 4.8500 },
    ]
    const tap = { lat: 45.0005, lng: 4.8500 }
    const res = findAnchorWindow(path, tap, 500)
    expect(res).not.toBeNull()
    expect(res!.idxA).toBe(0)
    expect(res!.idxB).toBe(1)
    expect(res!.rejectedSubPath).toHaveLength(2)
  })

  it('rejectedSubPath is always a strict sub-array of path', () => {
    const tap = { lat: 45.0020, lng: 4.8500 }
    const res = findAnchorWindow(PATH5, tap, 200)!
    for (let i = 0; i < res.rejectedSubPath.length; i++) {
      expect(res.rejectedSubPath[i]).toEqual(PATH5[res.idxA + i])
    }
  })
})
