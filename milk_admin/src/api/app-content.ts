import { get, put } from './http'

// ── App content (customize2 §3E): 5 slots keyed by slot+locale ──────────────
export type AppContentSlot =
  | 'CUSTOMER_HOME_BANNER'
  | 'CUSTOMER_OFFERS_CARD'
  | 'RIDER_HOME_ANNOUNCEMENT'
  | 'CUSTOMER_HELP'
  | 'RIDER_HELP'
export type AppContentLocale = 'en' | 'hi' | 'te'

export interface AppContentRecord {
  slot: AppContentSlot
  locale: AppContentLocale
  enabled: boolean
  title: string | null
  body: string | null
  imageMediaId: string | null
  imageUrl: string | null
  destination: string | null
  startAt: string | null
  endAt: string | null
  version: number
  updatedBy: string | null
  updatedAt: string
}

export interface AppContentHistoryEntry {
  id: string
  version: number
  enabled: boolean
  title: string | null
  body: string | null
  imageMediaId: string | null
  destination: string | null
  startAt: string | null
  endAt: string | null
  updatedBy: string | null
  createdAt: string
}

export const APP_CONTENT_SLOTS: AppContentSlot[] = [
  'CUSTOMER_HOME_BANNER',
  'CUSTOMER_OFFERS_CARD',
  'RIDER_HOME_ANNOUNCEMENT',
  'CUSTOMER_HELP',
  'RIDER_HELP',
]

/** Per-slot destination allowlist (mirrors the server). */
export const APP_CONTENT_DESTINATIONS: Record<AppContentSlot, string[]> = {
  CUSTOMER_HOME_BANNER: ['/products', '/cart', '/support'],
  CUSTOMER_OFFERS_CARD: ['/cart', '/offers', '/products', '/support'],
  RIDER_HOME_ANNOUNCEMENT: ['/support', '/notifications'],
  CUSTOMER_HELP: ['/support'],
  RIDER_HELP: ['/support', '/notifications'],
}

export function listAppContent(): Promise<AppContentRecord[]> {
  return get<AppContentRecord[]>('/v1/admin/app-content')
}

export interface AppContentWriteInput {
  enabled: boolean
  title?: string | null
  body?: string | null
  imageMediaId?: string | null
  destination?: string | null
  startAt?: string | null
  endAt?: string | null
  expectedVersion: number
}

export function writeAppContent(slot: AppContentSlot, locale: AppContentLocale, input: AppContentWriteInput): Promise<AppContentRecord> {
  return put<AppContentRecord>(`/v1/admin/app-content/${slot}/${locale}`, input)
}

export function getAppContentHistory(slot: AppContentSlot, locale: AppContentLocale): Promise<AppContentHistoryEntry[]> {
  return get<AppContentHistoryEntry[]>(`/v1/admin/app-content/${slot}/${locale}/history`)
}
