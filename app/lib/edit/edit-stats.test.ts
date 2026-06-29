import { describe, it, expect } from 'vitest'
import { recomputeStats, editErrorMessage } from './edit-stats'
import { haversineMeters } from '../shared/geo'

const A = { lat: 45.0, lng: 5.0 }
const B = { lat: 45.01, lng: 5.01 }
const C = { lat: 45.02, lng: 5.02 }

describe('recomputeStats', () => {
  it('returns 0 distance for fewer than 2 points', () => {
    expect(recomputeStats([], []).distanceMeters).toBe(0)
    expect(recomputeStats([A], []).distanceMeters).toBe(0)
  })

  it('sums one segment for a 2-point path', () => {
    const stats = recomputeStats([A, B], [3])
    expect(stats.distanceMeters).toBeCloseTo(haversineMeters(A, B), 5)
  })

  it('sums all segments for a multi-point path', () => {
    const ab = haversineMeters(A, B)
    const bc = haversineMeters(B, C)
    expect(recomputeStats([A, B, C], [3, 5]).distanceMeters).toBeCloseTo(ab + bc, 5)
  })

  it('maxGradePct = max(slopeProfile) — AC-PENTE', () => {
    expect(recomputeStats([A, B, C], [3, 5]).maxGradePct).toBe(5)
    expect(recomputeStats([A, B, C], [7, 2]).maxGradePct).toBe(7)
    expect(recomputeStats([A, B], [12]).maxGradePct).toBe(12)
  })

  it('maxGradePct is null when slopeProfile is empty', () => {
    expect(recomputeStats([], []).maxGradePct).toBeNull()
    expect(recomputeStats([A, B], []).maxGradePct).toBeNull()
  })

  it('durationSeconds and counterFlowCount are always null', () => {
    const stats = recomputeStats([A, B], [3])
    expect(stats.durationSeconds).toBeNull()
    expect(stats.counterFlowCount).toBeNull()
  })
})

describe('editErrorMessage', () => {
  it('maps each error to a distinct non-empty French string', () => {
    const msgs = [
      editErrorMessage('NO_LOCAL_ROUTE'),
      editErrorMessage('POINT_OFF_NETWORK'),
      editErrorMessage('ROUTING_UNAVAILABLE'),
    ]
    for (const m of msgs) {
      expect(typeof m).toBe('string')
      expect(m.length).toBeGreaterThan(0)
    }
    // All three messages are distinct
    expect(new Set(msgs).size).toBe(3)
  })

  it('NO_LOCAL_ROUTE mentions annulation — NOT retryable (AC-CAT #2/#16)', () => {
    const msg = editErrorMessage('NO_LOCAL_ROUTE')
    expect(msg).toMatch(/annule/i)
    expect(msg).toMatch(/itin/i) // "itinéraire"
  })

  it('POINT_OFF_NETWORK tells user to reposition — AC-C (#6)', () => {
    expect(editErrorMessage('POINT_OFF_NETWORK')).toMatch(/d[ée]place/i)
  })

  it('ROUTING_UNAVAILABLE is retryable and distinct from the other two', () => {
    const msg = editErrorMessage('ROUTING_UNAVAILABLE')
    expect(msg).not.toMatch(/annule/i)
    expect(msg).not.toMatch(/d[ée]place/i)
    // hints at retry
    expect(msg).toMatch(/r[ée]essaie/i)
  })
})
