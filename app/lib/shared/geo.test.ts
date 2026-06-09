import { describe, it, expect } from 'vitest'
import { haversineMeters, pathLengthMeters, geohashEncode, geohashOf } from './geo'

describe('haversineMeters', () => {
  it('is ~0 for identical points', () => {
    expect(haversineMeters({ lat: 44.84, lng: -0.58 }, { lat: 44.84, lng: -0.58 })).toBeCloseTo(0, 5)
  })

  it('matches a known distance Bordeaux→Grenoble (~497 km)', () => {
    const d = haversineMeters({ lat: 44.8378, lng: -0.5792 }, { lat: 45.1885, lng: 5.7245 })
    expect(d).toBeGreaterThan(495_000)
    expect(d).toBeLessThan(499_000)
  })

  it('~111 km per degree of latitude', () => {
    const d = haversineMeters({ lat: 0, lng: 0 }, { lat: 1, lng: 0 })
    expect(d).toBeGreaterThan(110_000)
    expect(d).toBeLessThan(112_000)
  })
})

describe('pathLengthMeters', () => {
  it('returns 0 for fewer than 2 points', () => {
    expect(pathLengthMeters([])).toBe(0)
    expect(pathLengthMeters([{ lat: 1, lng: 1 }])).toBe(0)
  })

  it('sums segments and equals haversine for a 2-point path', () => {
    const a = { lat: 44.84, lng: -0.58 }
    const b = { lat: 44.85, lng: -0.57 }
    expect(pathLengthMeters([a, b])).toBeCloseTo(haversineMeters(a, b), 6)
  })
})

describe('geohashEncode', () => {
  it('encodes a known reference point', () => {
    // Classic geohash reference: (57.64911, 10.40744) -> "u4pruydqqvj"
    expect(geohashEncode(57.64911, 10.40744, 11)).toBe('u4pruydqqvj')
  })

  it('honours precision and is a prefix relationship', () => {
    const long = geohashEncode(44.8378, -0.5792, 9)
    expect(long).toHaveLength(9)
    expect(long.startsWith(geohashEncode(44.8378, -0.5792, 6))).toBe(true)
  })

  it('geohashOf matches geohashEncode', () => {
    expect(geohashOf({ lat: 44.8378, lng: -0.5792 })).toBe(geohashEncode(44.8378, -0.5792, 6))
  })

  it('rejects out-of-range coordinates', () => {
    expect(() => geohashEncode(91, 0)).toThrow()
    expect(() => geohashEncode(0, 181)).toThrow()
  })
})
