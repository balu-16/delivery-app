import type { RangeKey } from '@/types'

// ── Shared mapping helpers used by the domain api modules ────────────────────

/** UPPER_SNAKE → lower_snake (order/payment/enum statuses). */
export function lowerStatus(value: string | null | undefined): string {
  if (!value) return ''
  return value.toLowerCase()
}

/**
 * Range key → {from,to} ISO instants resolved in IST (UTC+05:30) so the backend
 * receives exact UTC boundaries for the admin's "today".
 */
export function rangeToFromTo(range: RangeKey, now: Date = new Date()): { from: string; to: string } {
  const IST_OFFSET_MIN = 330
  // Shift into IST, truncate to IST midnight via UTC getters (timezone-safe),
  // then shift back to UTC.
  const istNow = new Date(now.getTime() + IST_OFFSET_MIN * 60_000)
  const istMidnightUtcMs = Date.UTC(
    istNow.getUTCFullYear(), istNow.getUTCMonth(), istNow.getUTCDate(),
  )
  let days = 0
  if (range === '7d') days = 6
  else if (range === '30d') days = 29
  else if (range === '90d') days = 89
  const startUtcMs = istMidnightUtcMs - days * 86_400_000 - IST_OFFSET_MIN * 60_000
  const endUtcMs = now.getTime()
  return { from: new Date(startUtcMs).toISOString(), to: new Date(endUtcMs).toISOString() }
}

/**
 * Range key → IST business dates as `YYYY-MM-DD` (date-only). Endpoints that
 * bucket by IST business day (dashboard) require this shape; a UTC datetime
 * here would both fail validation and shift the day boundary by 5½ hours.
 */
export function istDateWindow(range: RangeKey, now: Date = new Date()): { from: string; to: string } {
  const IST_OFFSET_MIN = 330
  const istNow = new Date(now.getTime() + IST_OFFSET_MIN * 60_000)
  const day = (ms: number) => new Date(ms).toISOString().slice(0, 10)
  let days = 0
  if (range === '7d') days = 6
  else if (range === '30d') days = 29
  else if (range === '90d') days = 89
  const todayUtcMs = Date.UTC(istNow.getUTCFullYear(), istNow.getUTCMonth(), istNow.getUTCDate())
  return { from: day(todayUtcMs - days * 86_400_000), to: day(todayUtcMs) }
}

/** GeoJSON Polygon (ring 0) → [lat,lng][] points for the Leaflet editor. */
export function polygonToPoints(geometry: object | null | undefined): [number, number][] {
  if (!geometry || typeof geometry !== 'object') return []
  const g = geometry as { coordinates?: unknown }
  let ring: unknown = g.coordinates
  if (!Array.isArray(ring) || ring.length === 0) return []
  const first = ring[0]
  if (Array.isArray(first) && Array.isArray(first[0])) {
    // wrapped: Polygon {[ring]} or MultiPolygon {[[ring]]} — take ring 0
    const inner = first[0]
    ring = Array.isArray(inner) && Array.isArray((inner as unknown[])[0]) ? inner : first
  }
  // flat ring: [[lng,lat], …]
  if (!Array.isArray(ring)) return []
  return (ring as Array<[number, number]>)
    .filter((p) => Array.isArray(p) && p.length >= 2 && Number.isFinite(p[0]) && Number.isFinite(p[1]))
    .map(([lng, lat]) => [lat, lng] as [number, number])
}

/** [lat,lng][] → GeoJSON Polygon (auto-closes the ring). */
export function pointsToPolygon(points: [number, number][]): object {
  const ring = points.map(([lat, lng]) => [lng, lat])
  if (ring.length > 0) {
    const [firstLng, firstLat] = ring[0] as [number, number]
    const [lastLng, lastLat] = ring[ring.length - 1] as [number, number]
    if (firstLng !== lastLng || firstLat !== lastLat) ring.push([firstLng, firstLat])
  }
  return { type: 'Polygon', coordinates: [ring] }
}

/** minutes-of-day → "HH:MM" */
export function minutesToTime(min: number): string {
  const h = Math.floor(min / 60) % 24
  const m = min % 60
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

/** "HH:MM" → minutes-of-day */
export function timeToMinutes(t: string): number {
  const [h, m] = t.split(':').map((v) => Number(v))
  if (!Number.isFinite(h) || !Number.isFinite(m)) return 0
  return h * 60 + m
}
