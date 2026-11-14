import { get, put, del, buildQuery, sendIdempotent } from './http'
import type { CursorPage, DeliverySlot, SubscriptionHoliday, SubscriptionPlan, SubscriptionRun } from '@/types'

// ── Subscriptions: plans / slots / holidays / runs ───────────────────────────

interface PlanApiRow { variantId: string; active: boolean; version: string }
interface SlotApiRow { id: string; storeId: string; name: string; startTime: string; endTime: string; active: boolean; version?: string }
interface HolidayApiRow { storeId: string; date: string; reason: string | null }
interface RunApiRow {
  id: string; storeId?: string | null; runDate?: string | null; status?: string
  generatedCount?: number | null; failedCount?: number | null; lastError?: string | null; createdAt?: string
}

export function subscriptionPlans(limit = 100, cursor?: string): Promise<CursorPage<SubscriptionPlan>> {
  return get<{ items: PlanApiRow[]; nextCursor: string | null }>(`/v1/admin/subscriptions/plans${buildQuery({ limit, cursor })}`).then((res) => ({
    items: (res.items ?? []).map((r) => ({ variantId: r.variantId, active: r.active, version: r.version ?? '1' })),
    nextCursor: res.nextCursor ?? null,
  }))
}

export const saveSubscriptionPlan = (idempotencyKey: string, variantId: string, active: boolean) =>
  sendIdempotent<unknown>('PUT', '/v1/admin/subscriptions/plans', { variantId, active }, idempotencyKey)

export function subscriptionSlots(storeId: string, limit = 50, cursor?: string): Promise<CursorPage<DeliverySlot>> {
  return get<{ items: SlotApiRow[]; nextCursor: string | null }>(`/v1/admin/subscriptions/slots${buildQuery({ storeId, limit, cursor })}`).then((res) => ({
    items: (res.items ?? []).map((r) => ({
      id: r.id, storeId: r.storeId, name: r.name, startTime: r.startTime, endTime: r.endTime,
      active: r.active, version: r.version ?? '1',
    })),
    nextCursor: res.nextCursor ?? null,
  }))
}

export interface SlotInput {
  id?: string
  storeId: string
  name: string
  startTime: string
  endTime: string
  active: boolean
}

export const saveSubscriptionSlot = (idempotencyKey: string, slot: SlotInput) =>
  sendIdempotent<unknown>('PUT', '/v1/admin/subscriptions/slots', slot, idempotencyKey)

export function subscriptionHolidays(storeId: string, limit = 50, cursor?: string): Promise<CursorPage<SubscriptionHoliday>> {
  return get<{ items: HolidayApiRow[]; nextCursor: string | null }>(`/v1/admin/subscriptions/holidays${buildQuery({ storeId, limit, cursor })}`).then((res) => ({
    items: (res.items ?? []).map((r) => ({ storeId: r.storeId, date: r.date, reason: r.reason ?? null })),
    nextCursor: res.nextCursor ?? null,
  }))
}

export const saveSubscriptionHoliday = (idempotencyKey: string, storeId: string, date: string, reason: string | null) =>
  sendIdempotent<unknown>('PUT', '/v1/admin/subscriptions/holidays', { storeId, date, reason: reason ?? undefined }, idempotencyKey)

export const deleteSubscriptionHoliday = (idempotencyKey: string, storeId: string, date: string) =>
  sendIdempotent<unknown>('DELETE', `/v1/admin/subscriptions/holidays/${storeId}/${date}`, {}, idempotencyKey)

export function subscriptionRuns(opts?: { storeId?: string; limit?: number; cursor?: string }): Promise<CursorPage<SubscriptionRun>> {
  return get<{ items: RunApiRow[]; nextCursor: string | null }>(`/v1/admin/subscriptions/runs${buildQuery({ storeId: opts?.storeId, limit: opts?.limit, cursor: opts?.cursor })}`).then((res) => ({
    items: (res.items ?? []).map((r) => ({
      id: r.id,
      storeId: r.storeId ?? null,
      runDate: r.runDate ?? null,
      status: (r.status ?? 'UNKNOWN').toLowerCase(),
      generatedCount: r.generatedCount ?? null,
      failedCount: r.failedCount ?? null,
      lastError: r.lastError ?? null,
      createdAt: r.createdAt ?? new Date(0).toISOString(),
    })),
    nextCursor: res.nextCursor ?? null,
  }))
}

/** Retry the failed generations of a run (Idempotency-Key, maker-checker safe). */
export const retrySubscriptionRun = (idempotencyKey: string, runId: string) =>
  sendIdempotent<unknown>('POST', `/v1/admin/subscriptions/runs/${runId}/retry`, {}, idempotencyKey)
