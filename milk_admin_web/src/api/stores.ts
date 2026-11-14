import { get, post, patch, put, del, buildQuery } from './http'
import type {
  City, CursorPage, LegalEntity, Store, StoreOperations, StoreStatus, Zone,
} from '@/types'

// ── Serviceability: cities / legal entities / stores / zones / operations ────

interface BackendPage<T> { items: T[]; nextCursor: string | null }

interface CityRow { id: string; name: string; bounds: object; zone_version: string }
interface EntityRow { id: string; name: string }
interface StoreRow {
  id: string; name: string; legal_entity_id: string; city_id: string
  status: 'ONLINE' | 'PAUSED' | 'OFFLINE'; pause_reason: string | null
  hourly_capacity: number; last_order_buffer_minutes: number
  accepts_cod: boolean; lat: number; lng: number; version: string
}
interface ZoneRow {
  id: string; name: string; store_id: string; priority: number
  active: boolean; version: string; geometry: object
}
interface HoursRow { weekday: number; start_minute: number; end_minute: number }
interface HolidayRow { day: string; closed: boolean }
interface HolidayHoursRow { day: string; start_minute: number; end_minute: number }
interface StaffRow { user_id: string; role: 'STORE_MANAGER' }
interface OperationsRow {
  hours: HoursRow[]; holidays: HolidayRow[]; holidayHours: HolidayHoursRow[]
  staff: StaffRow[]; nextHolidayCursor: string | null; nextStaffCursor: string | null
}

const mapCity = (r: CityRow): City => ({ id: r.id, name: r.name, bounds: r.bounds, zoneVersion: r.zone_version })
const mapEntity = (r: EntityRow): LegalEntity => ({ id: r.id, name: r.name })
const mapStore = (r: StoreRow): Store => ({
  id: r.id,
  name: r.name,
  legalEntityId: r.legal_entity_id,
  cityId: r.city_id,
  status: r.status.toLowerCase() as StoreStatus,
  pauseReason: r.pause_reason,
  hourlyCapacity: r.hourly_capacity,
  lastOrderBufferMinutes: r.last_order_buffer_minutes,
  acceptsCod: r.accepts_cod,
  lat: r.lat,
  lng: r.lng,
  version: r.version,
})
const mapZone = (r: ZoneRow): Zone => ({
  id: r.id, storeId: r.store_id, name: r.name,
  priority: r.priority, active: r.active, version: r.version, geometry: r.geometry,
})
export const mapOperations = (r: OperationsRow): StoreOperations => ({
  hours: (r.hours ?? []).map((h) => ({ weekday: h.weekday, startMinute: h.start_minute, endMinute: h.end_minute })),
  holidays: (r.holidays ?? []).map((h) => ({ day: h.day, closed: h.closed })),
  holidayHours: (r.holidayHours ?? []).map((h) => ({ day: h.day, startMinute: h.start_minute, endMinute: h.end_minute })),
  staff: (r.staff ?? []).map((s) => ({ userId: s.user_id, role: 'STORE_MANAGER' as const })),
  nextHolidayCursor: r.nextHolidayCursor ?? null,
  nextStaffCursor: r.nextStaffCursor ?? null,
})

async function page<T, R>(p: Promise<BackendPage<T>>, map: (row: T) => R): Promise<CursorPage<R>> {
  const res = await p
  return { items: (res.items ?? []).map(map), nextCursor: res.nextCursor ?? null }
}

// ── Legal entities ───────────────────────────────────────────────────────────
export function listLegalEntities(limit = 100, cursor?: string): Promise<CursorPage<LegalEntity>> {
  return page(get<BackendPage<EntityRow>>(`/v1/admin/legal-entities${buildQuery({ limit, cursor })}`), mapEntity)
}
export const createLegalEntity = (name: string) => post<{ id: string }>('/v1/admin/legal-entities', { name })
export const updateLegalEntity = (id: string, name: string) => patch<{ id: string }>(`/v1/admin/legal-entities/${id}`, { name })
export const deleteLegalEntity = (id: string) => del<unknown>(`/v1/admin/legal-entities/${id}`)

// ── Cities ───────────────────────────────────────────────────────────────────
export function listCities(limit = 100, cursor?: string): Promise<CursorPage<City>> {
  return page(get<BackendPage<CityRow>>(`/v1/admin/cities${buildQuery({ limit, cursor })}`), mapCity)
}
export const createCity = (name: string, bounds: object) => post<{ id: string }>('/v1/admin/cities', { name, bounds })
export const updateCity = (id: string, name: string, bounds: object) => patch<{ id: string }>(`/v1/admin/cities/${id}`, { name, bounds })
export const deleteCity = (id: string) => del<unknown>(`/v1/admin/cities/${id}`)

// ── Stores ───────────────────────────────────────────────────────────────────
export interface StoreInput {
  name: string
  legalEntityId: string
  cityId: string
  lat: number
  lng: number
  hourlyCapacity: number
  lastOrderBufferMinutes: number
}

export function listStores(limit = 100, cursor?: string): Promise<CursorPage<Store>> {
  return page(get<BackendPage<StoreRow>>(`/v1/admin/stores${buildQuery({ limit, cursor })}`), mapStore)
}
export const createStore = (input: StoreInput) => post<{ id: string }>('/v1/admin/stores', input)
export const updateStore = (id: string, input: StoreInput) => patch<{ id: string }>(`/v1/admin/stores/${id}`, input)
export const deleteStore = (id: string) => del<unknown>(`/v1/admin/stores/${id}`)

export const setStoreStatus = (id: string, status: 'ONLINE' | 'PAUSED', reason?: string) =>
  post<unknown>(`/v1/admin/stores/${id}/status`, reason ? { status, reason } : { status })

export const setStoreCod = (id: string, enabled: boolean, version: string) =>
  patch<{ enabled: boolean; version: string }>(`/v1/admin/stores/${id}/cod`, { enabled, version })

export const getStoreOperations = (id: string): Promise<StoreOperations> =>
  get<OperationsRow>(`/v1/admin/stores/${id}/operations`).then(mapOperations)

export interface HoursEntry { weekday: number; startMinute: number; endMinute: number }
export const replaceStoreHours = (id: string, entries: HoursEntry[]) =>
  put<unknown>(`/v1/admin/stores/${id}/hours`, { entries })

export interface HolidayInput { day: string; closed: boolean; windows: Array<{ startMinute: number; endMinute: number }> }
export const saveStoreHoliday = (id: string, holiday: HolidayInput) =>
  put<unknown>(`/v1/admin/stores/${id}/holidays`, holiday)
export const deleteStoreHoliday = (id: string, day: string) =>
  del<unknown>(`/v1/admin/stores/${id}/holidays/${day}`)

export const setStoreStaff = (id: string, userId: string, active: boolean) =>
  put<unknown>(`/v1/admin/stores/${id}/staff`, { userId, role: 'STORE_MANAGER', active })

// ── Zones ────────────────────────────────────────────────────────────────────
export interface ZoneInput {
  storeId: string
  name: string
  geometry: object
  priority: number
  active: boolean
}

export function listZones(limit = 100, cursor?: string): Promise<CursorPage<Zone>> {
  return page(get<BackendPage<ZoneRow>>(`/v1/admin/zones${buildQuery({ limit, cursor })}`), mapZone)
}
export const createZone = (input: ZoneInput) =>
  post<{ id: string; version: string; cityZoneVersion: string }>('/v1/admin/zones', input)
export const updateZone = (id: string, version: string, input: ZoneInput) =>
  patch<{ id: string; version: string; cityZoneVersion: string }>(`/v1/admin/zones/${id}`, { ...input, version })
export const deactivateZone = (id: string, version: string) =>
  del<{ id: string; version: string; cityZoneVersion: string }>(`/v1/admin/zones/${id}${buildQuery({ version })}`)
