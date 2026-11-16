import { get, post, patch, del, buildQuery, sendIdempotent } from './http'
import { lowerStatus } from './mapping'
import { paiseToRupees } from './money'
import type { AdminNotification, Coupon, CursorPage, NotificationPreference, PushCampaign } from '@/types'

// ── Offers: coupons / push campaigns / admin inbox ───────────────────────────

interface CouponApiRow {
  id: string; code: string; kind: 'PERCENT' | 'FLAT' | 'FREE_DELIVERY'
  value_paise?: string; value_bps?: string; value?: string
  max_cap_paise?: string | null; min_order_paise: string
  per_user_limit?: number | null; global_limit?: number | null
  valid_from?: string | null; valid_to?: string | null
  store_id?: string | null; category_id?: string | null; product_id?: string | null
  stackable?: boolean; first_order_only?: boolean; active?: boolean; version?: string
}

function mapCoupon(r: CouponApiRow): Coupon {
  const kind = r.kind.toLowerCase() as Coupon['kind']
  // PERCENT coupons carry basis points; FLAT/INR-based carry paise.
  const rawValue = r.value_bps ?? r.value_paise ?? r.value ?? '0'
  const value = kind === 'percent'
    ? Math.trunc(Number(rawValue) || 0) / 100 // bps → percent
    : paiseToRupees(rawValue)
  return {
    id: r.id,
    code: r.code,
    kind,
    value,
    maxCap: r.max_cap_paise ? paiseToRupees(r.max_cap_paise) : null,
    minOrder: paiseToRupees(r.min_order_paise),
    perUserLimit: r.per_user_limit ?? null,
    globalLimit: r.global_limit ?? null,
    validFrom: r.valid_from ?? null,
    validTo: r.valid_to ?? null,
    storeId: r.store_id ?? null,
    categoryId: r.category_id ?? null,
    productId: r.product_id ?? null,
    stackable: r.stackable ?? false,
    firstOrderOnly: r.first_order_only ?? false,
    active: r.active ?? false,
    version: r.version ?? '1',
  }
}

export function listCoupons(limit = 50, cursor?: string): Promise<CursorPage<Coupon>> {
  return get<{ items: CouponApiRow[]; nextCursor: string | null }>(`/v1/admin/coupons${buildQuery({ limit, cursor })}`).then((res) => ({
    items: (res.items ?? []).map(mapCoupon),
    nextCursor: res.nextCursor ?? null,
  }))
}

export interface CouponDraftInput {
  code: string
  kind: 'PERCENT' | 'FLAT' | 'FREE_DELIVERY'
  /** percent → basis points string; flat/free-delivery → paise string (flat uses it, free_delivery passes min). */
  valuePaise: string
  maxCapPaise?: string
  minOrderPaise: string
  perUserLimit?: number
  globalLimit?: number
  validFrom?: string
  validTo?: string
  storeId?: string
  categoryId?: string
  productId?: string
  excludedVariantIds?: string[]
  stackable: boolean
  firstOrderOnly: boolean
}

export const createCoupon = (idempotencyKey: string, draft: CouponDraftInput) =>
  sendIdempotent<unknown>('POST', '/v1/admin/coupons', draft, idempotencyKey)

export interface CouponPatchInput {
  perUserLimit?: number | null
  globalLimit?: number | null
  validFrom?: string | null
  validTo?: string | null
  minOrderPaise?: string
  active?: boolean
  expectedVersion: string
}

export const updateCoupon = (idempotencyKey: string, id: string, patchBody: CouponPatchInput) =>
  sendIdempotent<unknown>('PATCH', `/v1/admin/coupons/${id}`, patchBody, idempotencyKey)

// ── Push campaigns ───────────────────────────────────────────────────────────
export interface CampaignTargetInput {
  mode: 'ALL' | 'USERS' | 'PLATFORM'
  apps: Array<'CUSTOMER' | 'RIDER' | 'STORE' | 'ADMIN'>
  userIds?: string[]
  platform?: 'ANDROID' | 'WEB'
}

export interface CampaignPreviewResult {
  estimatedRecipients: number | null
  target: CampaignTargetInput
  kind: 'PROMOTIONAL' | 'OPERATIONAL'
}

/** Server-side audience count before any campaign is created. */
export function previewCampaign(input: { target: CampaignTargetInput; kind: 'PROMOTIONAL' | 'OPERATIONAL' }): Promise<CampaignPreviewResult> {
  return post<{ estimatedRecipients?: number } & Record<string, unknown>>('/v1/admin/push-campaigns/preview', input).then((res) => ({
    estimatedRecipients: typeof res.estimatedRecipients === 'number' ? res.estimatedRecipients : null,
    target: input.target,
    kind: input.kind,
  }))
}

export interface CampaignCreateInput {
  target: CampaignTargetInput
  kind: 'PROMOTIONAL' | 'OPERATIONAL'
  title: string
  body: string
  clickAction?: string
  imageUrl?: string
  data?: Record<string, string>
}

export const createCampaign = (idempotencyKey: string, input: CampaignCreateInput) =>
  sendIdempotent<{ id: string }>('POST', '/v1/admin/push-campaigns', input, idempotencyKey)

interface CampaignRow {
  id: string; title?: string; body?: string; kind?: string
  target?: { mode?: string; apps?: string[] }
  estimated_recipients?: number | null; recipients?: number | null
  created_at?: string
}

function mapCampaign(r: CampaignRow): PushCampaign {
  return {
    id: r.id,
    title: r.title ?? 'Campaign',
    body: r.body ?? '',
    kind: (r.kind ?? 'PROMOTIONAL').toLowerCase() as PushCampaign['kind'],
    target: { mode: (r.target?.mode ?? 'ALL').toLowerCase() as PushCampaign['target']['mode'], apps: r.target?.apps ?? [] },
    recipients: (r.estimated_recipients ?? r.recipients ?? null) as number | null,
    createdAt: r.created_at ?? new Date(0).toISOString(),
  }
}

export function listCampaigns(cursor?: string): Promise<CursorPage<PushCampaign>> {
  return get<{ items: CampaignRow[]; nextCursor: string | null }>(`/v1/admin/push-campaigns${buildQuery({ cursor })}`).then((res) => ({
    items: (res.items ?? []).map(mapCampaign),
    nextCursor: res.nextCursor ?? null,
  }))
}

export function getCampaign(id: string, cursor?: string): Promise<PushCampaign & { deliveries?: unknown[]; nextCursor: string | null }> {
  return get<CampaignRow & { deliveries?: unknown[]; nextCursor?: string | null }>(`/v1/admin/push-campaigns/${id}${buildQuery({ cursor })}`).then((r) => ({
    ...mapCampaign(r),
    deliveries: r.deliveries ?? [],
    nextCursor: r.nextCursor ?? null,
  }))
}

// ── Admin inbox (self-scoped notifications) ──────────────────────────────────
interface NotificationApiRow {
  id: string; channel: string; templateKey: string; title: string; body: string
  category: string; class: string; read_at?: string | null; created_at?: string
}

function mapNotification(r: NotificationApiRow): AdminNotification {
  return {
    id: r.id,
    channel: r.channel as AdminNotification['channel'],
    templateKey: r.templateKey,
    title: r.title,
    body: r.body,
    category: r.category as AdminNotification['category'],
    class: r.class as AdminNotification['class'],
    readAt: r.read_at ?? null,
    createdAt: r.created_at ?? new Date(0).toISOString(),
  }
}

export function listInbox(cursor?: string, limit = 30): Promise<CursorPage<AdminNotification>> {
  return get<{ items: NotificationApiRow[]; nextCursor: string | null }>(`/v1/admin/notifications${buildQuery({ cursor, limit })}`).then((res) => ({
    items: (res.items ?? []).map(mapNotification),
    nextCursor: res.nextCursor ?? null,
  }))
}

export const unreadCount = () => get<{ count: number }>('/v1/admin/notifications/unread-count')
export const markNotificationRead = (id: string) => post<{ read: boolean }>(`/v1/admin/notifications/${id}/read`, {})
export const markAllNotificationsRead = () => post<{ updated: number }>('/v1/admin/notifications/read-all', {})

// ── Notification preferences ─────────────────────────────────────────────────
export function getNotificationPreferences(): Promise<NotificationPreference[]> {
  return get<Array<{ category: string; enabled: boolean }>>('/v1/admin/notification-preferences').then((rows) =>
    (rows ?? []).map((r) => ({ category: r.category as NotificationPreference['category'], enabled: r.enabled })),
  )
}

export const updateNotificationPreferences = (updates: Array<{ category: string; enabled: boolean }>) =>
  patch<unknown>('/v1/admin/notification-preferences', { updates })

// ── Device tokens ────────────────────────────────────────────────────────────
export const registerDeviceToken = (input: { token: string; platform: 'ANDROID' | 'IOS' | 'WEB'; identifierType: 'FCM_TOKEN' | 'FID' }) =>
  post<{ registered: boolean }>('/v1/admin/device-tokens', input)

export const unregisterDeviceToken = (token: string) =>
  del<{ removed: boolean }>('/v1/admin/device-tokens', { token })
