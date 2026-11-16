import { describe, expect, it } from 'vitest'
import { paiseToRupees, rupeesToPaise, signedPaiseToRupees, signedRupeesToPaise } from '@/api/money'
import { lowerStatus, minutesToTime, polygonToPoints, pointsToPolygon, rangeToFromTo, istDateWindow } from '@/api/mapping'
import { dashboardMetrics } from '@/api/dashboard'
import type { DashboardData } from '@/types'

// ── Money adapters (paise STRINGS → rupees, integer-safe) ────────────────────
describe('money adapters', () => {
  it('converts paise strings to rupees without float drift', () => {
    expect(paiseToRupees('42000')).toBe(420)
    expect(paiseToRupees('1')).toBe(0.01)
    expect(paiseToRupees('0')).toBe(0)
    expect(paiseToRupees(null)).toBe(0)
    expect(paiseToRupees(undefined)).toBe(0)
    expect(paiseToRupees('not-a-number')).toBe(0)
  })

  it('converts rupees back to paise strings (rounded)', () => {
    expect(rupeesToPaise(420)).toBe('42000')
    expect(rupeesToPaise(420.5)).toBe('42050')
    expect(rupeesToPaise(0)).toBe('0')
    expect(rupeesToPaise(-5)).toBe('0') // clamped — amounts sent to the API are non-negative
  })

  it('handles signed ledger deltas', () => {
    expect(signedPaiseToRupees('-15000')).toBe(-150)
    expect(signedRupeesToPaise(-150)).toBe('-15000')
    expect(signedRupeesToPaise(12.34)).toBe('1234')
  })
})

// ── Status/enum adapters (UPPER_SNAKE → lower_snake) ─────────────────────────
describe('status adapters', () => {
  it('maps backend UPPER_SNAKE_CASE to UI lower_snake_case', () => {
    expect(lowerStatus('OUT_FOR_DELIVERY')).toBe('out_for_delivery')
    expect(lowerStatus('DELIVERED')).toBe('delivered')
    expect(lowerStatus('PENDING_PAYMENT')).toBe('pending_payment')
    expect(lowerStatus(null)).toBe('')
  })
})

// ── IST range resolution (dashboard/orders/reports windows) ──────────────────
describe('rangeToFromTo (IST)', () => {
  it('resolves "today" to the IST midnight boundary expressed in UTC', () => {
    // 2026-01-24T10:05:00Z = 15:35 IST → today starts 2026-01-23T18:30:00Z
    const now = new Date('2026-01-24T10:05:00.000Z')
    const { from, to } = rangeToFromTo('today', now)
    expect(from).toBe('2026-01-23T18:30:00.000Z')
    expect(new Date(to).getTime()).toBe(now.getTime())
  })

  it('resolves 7d as today minus 6 days (inclusive window)', () => {
    const now = new Date('2026-01-24T10:05:00.000Z')
    const { from } = rangeToFromTo('7d', now)
    expect(from).toBe('2026-01-17T18:30:00.000Z')
  })

  it('resolves 90d correctly', () => {
    const now = new Date('2026-01-24T10:05:00.000Z')
    const { from } = rangeToFromTo('90d', now)
    expect(from).toBe('2025-10-26T18:30:00.000Z')
  })
})

// ── IST date-only window (dashboard contract: strict YYYY-MM-DD) ─────────────
describe('istDateWindow (IST business dates)', () => {
  it('returns date-only strings — never datetimes', () => {
    const now = new Date('2026-01-24T10:05:00.000Z') // 15:35 IST
    const { from, to } = istDateWindow('today', now)
    expect(from).toBe('2026-01-24')
    expect(to).toBe('2026-01-24')
    expect(from).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(to).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('buckets by the IST calendar date even near UTC midnight', () => {
    // 2026-01-24T19:30:00Z = 01:00 IST on 2026-01-25 → "today" must be the 25th
    const now = new Date('2026-01-24T19:30:00.000Z')
    const { to } = istDateWindow('today', now)
    expect(to).toBe('2026-01-25')
  })

  it('resolves 30d as today minus 29 IST days', () => {
    const now = new Date('2026-01-24T10:05:00.000Z')
    const { from } = istDateWindow('30d', now)
    expect(from).toBe('2025-12-26')
  })
})

// ── GeoJSON polygon adapters (zone editor ↔ backend geometry) ────────────────
describe('polygon adapters', () => {
  it('round-trips a GeoJSON Polygon through editor points', () => {
    const geometry = { type: 'Polygon', coordinates: [[[72.87, 19.07], [72.89, 19.07], [72.89, 19.09], [72.87, 19.07]]] }
    const points = polygonToPoints(geometry)
    expect(points).toEqual([[19.07, 72.87], [19.07, 72.89], [19.09, 72.89], [19.07, 72.87]])
    const back = pointsToPolygon(points) as { type: string; coordinates: number[][][] }
    expect(back.type).toBe('Polygon')
    // the source ring was already closed (first == last) — length stays 4
    expect(back.coordinates[0]).toHaveLength(4)
    const reopened = polygonToPoints(back)
    expect(reopened).toEqual(points)
  })

  it('handles MultiPolygon by taking the first ring and rejects junk', () => {
    const multi = { type: 'MultiPolygon', coordinates: [[[[0, 0], [1, 1], [1, 0], [0, 0]]]] }
    expect(polygonToPoints(multi)).toHaveLength(4)
    expect(polygonToPoints(null)).toEqual([])
    expect(polygonToPoints({})).toEqual([])
  })

  it('auto-closes an open ring on save', () => {
    const open = pointsToPolygon([[19.0, 72.8], [19.1, 72.8], [19.1, 72.9]] as [number, number][]) as { coordinates: number[][][] }
    expect(open.coordinates[0]).toHaveLength(4)
    expect(open.coordinates[0]![0]).toEqual(open.coordinates[0]![3])
  })
})

// ── Time adapters ────────────────────────────────────────────────────────────
describe('minutesToTime', () => {
  it('formats minutes-of-day as HH:MM', () => {
    expect(minutesToTime(360)).toBe('06:00')
    expect(minutesToTime(1320)).toBe('22:00')
    expect(minutesToTime(0)).toBe('00:00')
  })
})

// ── Dashboard metric derivation (nulls honoured, never fabricated) ───────────
describe('dashboardMetrics', () => {
  const full: DashboardData = {
    period: { from: '2026-01-01T00:00:00.000Z', to: '2026-01-31T00:00:00.000Z' },
    invoicedSalesPaise: '104000',
    creditNotesPaise: '4000',
    refundsProcessedPaise: '12000',
    walletTopUpsPaise: { total: '50000' },
    orders: { placed: 48, confirmed: 20, picking: 30, packed: 10, outForDelivery: 62, delivered: 982, cancelled: 24, expired: 10, onHold: 12 },
    stores: { total: 8, online: 6 },
    customers: { total: 480, active: 210 },
  }

  it('derives in-progress = confirmed+picking+packed and cancelled = cancelled+expired', () => {
    const m = dashboardMetrics(full)
    expect(m.ordersInProgress).toBe(60)
    expect(m.ordersCancelled).toBe(34)
    expect(m.sales).toBe(1040)
    expect(m.creditNotes).toBe(40)
    expect(m.walletTopUps).toBe(500)
    expect(m.storesOnline).toBe(6)
  })

  it('wallet top-ups become null when store-filtered (global metric)', () => {
    const m = dashboardMetrics({ ...full, walletTopUpsPaise: null })
    expect(m.walletTopUps).toBeNull()
  })

  it('null orders block render as null (UI shows —, never 0-as-data)', () => {
    const m = dashboardMetrics({ ...full, orders: null })
    expect(m.ordersPlaced).toBeNull()
    expect(m.ordersInProgress).toBeNull()
  })
})
