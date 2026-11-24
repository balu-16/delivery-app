/**
 * Store portal mutations — real backend calls with idempotency keys,
 * toasts that reflect actual outcomes, and targeted query invalidation.
 * No client-side state changes: the server response is the truth.
 */
import { useCallback } from 'react'
import { toast } from '@dairydirect/shared/lib/toast'
import { useQueryClient } from '@tanstack/react-query'
import { useStoreAuth, useActiveStore } from '@/login/authStore'
import { apiPost, apiPatch, newIdempotencyKey, ApiError, getCsrfToken } from './http'
import * as storeApi from './storeApi'
import type { QualityDecision, StoreNotificationPrefs } from '@dairydirect/shared/types'

const HEADERS = () => {
  // apiPost handles the csrf header; kept explicit here for documentation.
  if (!getCsrfToken()) throw new ApiError(0, 'SESSION_BOOTSTRAP', 'Session not ready')
  return undefined
}
void HEADERS

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiError) {
    if (error.code === 'NETWORK_ERROR') return 'Network problem — retry in a moment'
    if (error.status >= 500) return 'Something went wrong on our side. Please try again.'
    return error.detail || fallback
  }
  return fallback
}

/** Run a mutation against the backend, toast the outcome and refresh queries. */
export function useStoreApply() {
  const qc = useQueryClient()
  return useCallback(
    async <T,>(action: () => Promise<T>, message?: string, invalidate: string[] = ['store']): Promise<T | null> => {
      try {
        const result = await action()
        for (const key of invalidate) await qc.invalidateQueries({ queryKey: [key] })
        if (message) toast.success(message)
        return result
      } catch (error) {
        toast.error(errorMessage(error, 'That did not go through — please retry'))
        return null
      }
    },
    [qc],
  )
}

function useManager() {
  const user = useStoreAuth((s) => s.user)
  const activeId = useActiveStore((s) => s.activeStoreId)
  const storeId = user ? (activeId && user.assignedStoreIds.includes(activeId) ? activeId : user.assignedStoreIds[0] ?? null) : null
  const storeName = user?.stores.find((s) => s.storeId === storeId)?.name ?? 'Store'
  return { name: user?.name ?? 'Store Manager', id: user?.id ?? '', storeId, storeName }
}

// ── §2 Picking ──────────────────────────────────────────────────
export function usePickingActions() {
  const run = useStoreApply()
  const manager = useManager()
  return {
    claim: (taskId: string) =>
      run(() => apiPost(`/v1/store/pick-tasks/${taskId}/claim`, undefined, newIdempotencyKey()), 'Task claimed by you'),
    start: (taskId: string) =>
      run(() => apiPost(`/v1/store/pick-tasks/${taskId}/start`, undefined, newIdempotencyKey()), 'Picking started'),
    release: (taskId: string) =>
      run(() => apiPost(`/v1/store/pick-tasks/${taskId}/release`, undefined, newIdempotencyKey()), 'Task released back to the queue'),
    heartbeat: (taskId: string) => apiPost(`/v1/store/pick-tasks/${taskId}/heartbeat`, undefined, newIdempotencyKey()),
    pickLine: (taskId: string, itemId: string, scannedBarcode: string, quantity: number, batchId?: string) =>
      run(() => apiPost(`/v1/store/pick-tasks/${taskId}/items/${itemId}/pick`, {
        scannedBarcode,
        quantity: String(Math.max(1, Math.round(quantity))),
        ...(batchId ? { batchId } : {}),
      }, newIdempotencyKey())),
    substitute: (taskId: string, itemId: string, candidateVariantId: string, scannedBarcode: string, batchId?: string) =>
      run(() => apiPost(`/v1/store/pick-tasks/${taskId}/items/${itemId}/substitute`, {
        candidateVariantId,
        scannedBarcode,
        ...(batchId ? { batchId } : {}),
      }, newIdempotencyKey()), 'Substitute recorded'),
    markUnavailable: (taskId: string, itemId: string, reason: 'OUT_OF_STOCK' | 'DAMAGED' | 'EXPIRED' | 'NOT_FOUND') =>
      run(() => apiPost(`/v1/store/pick-tasks/${taskId}/items/${itemId}/short`, { reason }, newIdempotencyKey()), 'Item marked unavailable'),
    completePicking: (taskId: string) =>
      run(() => apiPost(`/v1/store/pick-tasks/${taskId}/complete`, undefined, newIdempotencyKey()), 'Picking complete — ready to pack'),
    savePacking: (orderId: string, bags: number, coldChain: boolean, sealCode: string) =>
      run(() => apiPost(`/v1/store/orders/${orderId}/pack`, {
        bags: String(Math.max(1, Math.round(bags))),
        sealCode,
        coldChain,
      }, newIdempotencyKey()), 'Packed — ready for handover'),
    verifyHandover: (orderId: string, handoverCode: string, override?: boolean, reason?: string) =>
      run(() => apiPost(`/v1/store/orders/${orderId}/handover`, {
        ...(handoverCode ? { handoverCode } : {}),
        ...(override ? { override: true, reason } : {}),
      }, newIdempotencyKey()), 'Handover verified — rider can deliver'),
    reassign: (taskId: string, toUserId: string, assigneeName: string, reason: string) =>
      run(() => apiPost(`/v1/store/pick-tasks/${taskId}/reassign`, { toUserId, reason }, newIdempotencyKey()), `Task reassigned to ${assigneeName}`),
    managerName: manager.name,
  }
}

// ── §4 Returns ──────────────────────────────────────────────────
export interface ReturnRecordItem {
  variantId: string
  quantity: string
  expiresAt?: string | null
}
export function useReturnActions() {
  const run = useStoreApply()
  return {
    record: (orderId: string, reason: string, items: ReturnRecordItem[]) =>
      run(() => apiPost(`/v1/store/orders/${orderId}/return`, { reason, items }, newIdempotencyKey()), 'Return recorded — inspection pending'),
    saveDraft: (storeId: string, orderId: string, items: Array<{ variantId: string; quantity: string; decision: 'SALEABLE' | 'DAMAGED' | 'EXPIRED'; note: string | null }>, note: string | null) =>
      run(() => apiPost(`/v1/store/returns/orders/${orderId}/draft`, { storeId, items, note }), 'Draft saved'),
    decide: (returnId: string, decision: QualityDecision, reason: string) =>
      run(() => apiPost(`/v1/store/returns/${returnId}/qc`, {
        result: decision === 'saleable' ? 'APPROVE' : 'REJECT',
        reason,
      }, newIdempotencyKey()), decision === 'saleable' ? 'Return approved — stock restocked' : 'Return rejected — written off'),
    /** QC is per return row; submit the drawer's decisions in one audited batch. */
    completeInspection: (entries: Array<{ returnId: string; decision: QualityDecision; reason: string }>) =>
      run(async () => {
        for (const entry of entries) {
          await apiPost(`/v1/store/returns/${entry.returnId}/qc`, {
            result: entry.decision === 'saleable' ? 'APPROVE' : 'REJECT',
            reason: entry.reason,
          }, newIdempotencyKey())
        }
        return entries.length
      }, 'Inspection completed — stock updated'),
    managerName: useStoreAuth((s) => s.user)?.name ?? 'Store Manager',
  }
}

// ── §5 Rider documents ──────────────────────────────────────────
export function useRiderDocActions() {
  const run = useStoreApply()
  return {
    decide: (documentId: string, _docType: string, status: 'approved' | 'rejected', reason?: string) =>
      run(() => apiPost(`/v1/store/rider-documents/${documentId}/review`, {
        approved: status === 'approved',
        reason: status === 'approved' ? 'Approved' : reason ?? 'Rejected',
      }, newIdempotencyKey()),
        status === 'approved' ? 'Document approved' : 'Document rejected — rider notified to re-upload'),
    readUrl: (documentId: string) => apiPost<{ readUrl: string; expiresAt?: string }>(`/v1/store/rider-documents/${documentId}/read-url`, {}),
  }
}

// ── §6 COD deposits ─────────────────────────────────────────────
/** Integer paise from a rupee amount, without float drift. */
export function rupeesToPaise(rupees: number): string {
  return String(Math.round(rupees * 100))
}
export function useCodActions() {
  const run = useStoreApply()
  const manager = useManager()
  return {
    record: (riderId: string, riderName: string, rupees: number) =>
      run(
        () => apiPost<{ id: string; discrepancyPaise: string }>('/v1/store/cod/deposits', {
          storeId: manager.storeId,
          riderId,
          amountPaise: rupeesToPaise(rupees),
        }, newIdempotencyKey()),
        `${rupees.toFixed(2)} deposited for ${riderName}`,
      ),
    storeId: manager.storeId,
    storeName: manager.storeName,
  }
}

// ── §3 Inventory ────────────────────────────────────────────────
export function useStoreInventoryActions() {
  const run = useStoreApply()
  const manager = useManager()
  return {
    receiveStock: (storeId: string, variantId: string, batchNo: string, qty: number, expiresAt?: string) =>
      run(() => apiPost('/v1/store/inventory/receipts', {
        storeId,
        variantId,
        batchCode: batchNo,
        quantity: String(Math.max(1, Math.round(qty))),
        ...(expiresAt ? { expiresAt } : {}),
      }, newIdempotencyKey()), `Stock received: ${qty} units`),
    setBin: (storeId: string, variantId: string, location: string) =>
      run(() => apiPost('/v1/store/inventory/bin-location', { storeId, variantId, location }, newIdempotencyKey()), `Bin location set to ${location}`),
    createCountSession: (note?: string) =>
      run(() => storeApi.createCountSession(manager.storeId!, note), 'Stock count started'),
    updateCountSession: (sessionId: string, lines: Array<{ batchId: string; counted: string | null; reason?: string | null }>, expectedVersion?: string) =>
      run(() => storeApi.updateCountSession(sessionId, lines, expectedVersion), 'Count saved'),
    completeCountSession: (sessionId: string) =>
      run(() => apiPost(`/v1/store/inventory/count-sessions/${sessionId}/complete`, undefined, newIdempotencyKey()), 'Stock count completed — adjustments applied'),
    cancelCountSession: (sessionId: string) =>
      run(() => apiPost(`/v1/store/inventory/count-sessions/${sessionId}/cancel`, {}), 'Stock count cancelled'),
    // No success message: the caller toasts from the server result so a
    // pending approval is distinguished from an immediately applied delta.
    createAdjustment: (storeId: string, variantId: string, batchId: string, delta: number, expectedVersion: string, reason: string) =>
      run(() => apiPost<{ approvalId?: string }>('/v1/store/inventory/adjustments', {
        storeId,
        variantId,
        batchId,
        delta: String(Math.round(delta)),
        expectedVersion,
        reason,
      }, newIdempotencyKey())),
  }
}

// ── §7 Store status ─────────────────────────────────────────────
export function useStoreStatusActions() {
  const run = useStoreApply()
  return {
    pause: (storeId: string, reason: string) =>
      run(() => apiPost('/v1/store/status', { storeId, status: 'PAUSED', reason }, newIdempotencyKey()), 'Store paused'),
    resume: (storeId: string) =>
      run(() => apiPost('/v1/store/status', { storeId, status: 'ONLINE' }, newIdempotencyKey()), 'Store resumed — accepting orders'),
  }
}

// ── §8 Staff reassign ───────────────────────────────────────────
export function useStaffActions() {
  const picking = usePickingActions()
  return picking
}

// ── §9 Notifications & prefs ────────────────────────────────────
export function useStoreNotificationActions() {
  const run = useStoreApply()
  const qc = useQueryClient()
  return {
    markNotificationRead: (id?: string) => {
      if (!id) return run(() => apiPost('/v1/store/notifications/read-all', {}), 'All notifications marked read')
      return run(() => apiPost(`/v1/store/notifications/${id}/read`, {}))
    },
    markNotificationUnread: (id: string) =>
      run(() => apiPost(`/v1/store/notifications/${id}/unread`, {}), 'Marked unread'),
    markAllRead: () => run(() => apiPost('/v1/store/notifications/read-all', {}), 'All notifications marked read'),
    setPrefs: (prefs: StoreNotificationPrefs) =>
      run(() => apiPatch('/v1/store/notification-preferences', {
        updates: (['pickingOrders', 'inventoryAlerts', 'riderApplications', 'codDeposits', 'storeStatus'] as const).map((key) => ({
          category: ({ pickingOrders: 'ORDER_UPDATES', inventoryAlerts: 'STORE_OPS', riderApplications: 'RIDING', codDeposits: 'PAYMENTS', storeStatus: 'ADMIN' } as const)[key],
          enabled: prefs[key],
        })),
      }), 'Notification preferences saved'),
    /** Cross-tab logout broadcast (AppShell guard listens on this channel). */
    broadcastLogout: () => {
      try { new BroadcastChannel('dd_store_session').postMessage('logout') } catch { /* unsupported */ }
      void qc.invalidateQueries()
    },
  }
}
