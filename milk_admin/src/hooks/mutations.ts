import { useRef } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from '@/lib/toast'
import { newIdempotencyKey } from '@/api/http'
import { rupeesToPaise, signedRupeesToPaise } from '@/api/money'
import { pointsToPolygon } from '@/api/mapping'
import * as apiStores from '@/api/stores'
import * as apiCatalog from '@/api/catalog'
import * as apiInventory from '@/api/inventory'
import * as apiOrders from '@/api/orders'
import * as apiPeople from '@/api/people'
import * as apiPayments from '@/api/payments'
import * as apiPayouts from '@/api/payouts'
import * as apiOffers from '@/api/offers'
import * as apiSubs from '@/api/subscriptions'
import * as apiSupport from '@/api/support'
import * as apiReports from '@/api/reports'
import type { ReportKind } from '@/types'
import * as apiApprovals from '@/api/approvals'
import * as apiSettings from '@/api/settings'
import { useAuth } from '@/store/auth'

/**
 * Mutations against the real backend. Toasts fire ONLY after the server
 * confirms; server validation errors surface via error.message (ApiError).
 *
 * Every actions hook creates ONE react-query mutation at render time whose
 * mutationFn dispatches (via refs) to the action invoked last — this keeps
 * hook calls render-only while pages keep the familiar
 * `actions.doThing(arg1, arg2).mutate(undefined, { onError, onSuccess })`.
 */

type Handlers<T> = {
  onError?: (error: Error) => void
  onSuccess?: (value: T) => void
}

export interface ActionHandle<T> {
  mutate: (variables: undefined, handlers?: Handlers<T>) => void
}

function fail(error: unknown, fallback: string) {
  const message = error instanceof Error ? error.message : fallback
  toast.error(message)
}

function useActionRunner(invalidate: () => void) {
  const runRef = useRef<null | ((args: unknown[]) => Promise<unknown>)>(null)
  const messageRef = useRef('Done')

  const mutation = useMutation<unknown, Error, unknown[]>({
    mutationFn: (args: unknown[]) => {
      const fn = runRef.current
      if (!fn) return Promise.resolve(undefined)
      return fn(args)
    },
    onError: (error) => fail(error, 'The server rejected the change.'),
  })

  function makeAction<A extends unknown[], T>(
    fn: (args: A) => Promise<T>,
    message: string | ((args: A) => string),
  ): (...args: A) => ActionHandle<T> {
    return (...args: A) => {
      runRef.current = fn as unknown as (args: unknown[]) => Promise<unknown>
      messageRef.current = typeof message === 'function' ? message(args) : message
      return {
        mutate: (_: undefined, handlers?: Handlers<T>) => {
          mutation.mutate(args, {
            onSuccess: (v) => {
              invalidate()
              toast.success(messageRef.current)
              handlers?.onSuccess?.(v as T)
            },
            onError: (e) => handlers?.onError?.(e),
          })
        },
      }
    }
  }

  return { makeAction }
}

// ── §2 Stores ────────────────────────────────────────────────────────────────
export function useStoreActions() {
  const qc = useQueryClient()
  const inv = () => {
    void qc.invalidateQueries({ queryKey: ['stores'] })
    void qc.invalidateQueries({ queryKey: ['cities'] })
    void qc.invalidateQueries({ queryKey: ['zones'] })
    void qc.invalidateQueries({ queryKey: ['legal-entities'] })
    void qc.invalidateQueries({ queryKey: ['store-operations'] })
    void qc.invalidateQueries({ queryKey: ['dashboard'] })
  }
  const { makeAction } = useActionRunner(inv)
  return {
    addStore: makeAction<[apiStores.StoreInput], { id: string }>(([input]) => apiStores.createStore(input), ([i]) => `Store "${i.name}" created`),
    updateStore: makeAction<[string, apiStores.StoreInput, string?], { id: string }>(([id, input, name]) => apiStores.updateStore(id, input), ([, , name]) => (name ? `${name} updated` : 'Store updated')),
    deleteStore: makeAction<[string, string], unknown>(([id]) => apiStores.deleteStore(id), ([, name]) => `Store "${name}" deleted`),
    setStoreStatus: makeAction<[string, 'ONLINE' | 'PAUSED', string?], unknown>(([id, status, reason]) => apiStores.setStoreStatus(id, status, reason), ([, status]) => (status === 'ONLINE' ? 'Store resumed' : 'Store paused')),
    setStoreCod: makeAction<[string, boolean, string], { enabled: boolean; version: string }>(([id, enabled, version]) => apiStores.setStoreCod(id, enabled, version), ([, enabled]) => (enabled ? 'COD enabled' : 'COD disabled')),
    saveHours: makeAction<[string, apiStores.HoursEntry[]], unknown>(([id, entries]) => apiStores.replaceStoreHours(id, entries), () => 'Opening hours saved'),
    saveHoliday: makeAction<[string, string, boolean, Array<{ startMinute: number; endMinute: number }>?], unknown>(([id, day, closed, windows]) => apiStores.saveStoreHoliday(id, { day, closed, windows: windows ?? [] }), () => 'Holiday saved'),
    deleteHoliday: makeAction<[string, string], unknown>(([id, day]) => apiStores.deleteStoreHoliday(id, day), () => 'Holiday removed'),
    setStaff: makeAction<[string, string, boolean], unknown>(([id, userId, active]) => apiStores.setStoreStaff(id, userId, active), ([, , active]) => (active ? 'Manager assigned' : 'Manager unassigned')),
    addCity: makeAction<[string, object], { id: string }>(([name, bounds]) => apiStores.createCity(name, bounds), ([name]) => `City "${name}" created`),
    updateCity: makeAction<[string, string, object], { id: string }>(([id, name, bounds]) => apiStores.updateCity(id, name, bounds), () => 'City updated'),
    deleteCity: makeAction<[string, string], unknown>(([id]) => apiStores.deleteCity(id), ([, name]) => `City "${name}" deleted`),
    addLegalEntity: makeAction<[string], { id: string }>(([name]) => apiStores.createLegalEntity(name), ([name]) => `Legal entity "${name}" created`),
    updateLegalEntity: makeAction<[string, string], { id: string }>(([id, name]) => apiStores.updateLegalEntity(id, name), () => 'Legal entity updated'),
    deleteLegalEntity: makeAction<[string, string], unknown>(([id]) => apiStores.deleteLegalEntity(id), ([, name]) => `Legal entity "${name}" deleted`),
    addZone: makeAction<[apiStores.ZoneInput], { id: string }>(([input]) => apiStores.createZone(input), ([i]) => `Zone "${i.name}" created`),
    updateZone: makeAction<[string, string, apiStores.ZoneInput], unknown>(([id, version, input]) => apiStores.updateZone(id, version, input), () => 'Zone updated'),
    deleteZone: makeAction<[string, string, string], unknown>(([id, version]) => apiStores.deactivateZone(id, version), ([, , name]) => `Zone "${name}" removed`),
  }
}

// ── §3 Products ──────────────────────────────────────────────────────────────
export function useProductActions() {
  const qc = useQueryClient()
  const inv = () => {
    void qc.invalidateQueries({ queryKey: ['products'] })
    void qc.invalidateQueries({ queryKey: ['variants'] })
    void qc.invalidateQueries({ queryKey: ['categories'] })
    void qc.invalidateQueries({ queryKey: ['brands'] })
    void qc.invalidateQueries({ queryKey: ['inventory-summary'] })
    void qc.invalidateQueries({ queryKey: ['inventory-report'] })
    void qc.invalidateQueries({ queryKey: ['approvals'] })
  }
  const { makeAction } = useActionRunner(inv)
  return {
    addCategory: makeAction<[string], { id: string }>(([name]) => apiCatalog.createCategory(name), ([name]) => `Category "${name}" created`),
    updateCategory: makeAction<[string, string], { id: string }>(([id, name]) => apiCatalog.updateCategory(id, name), () => 'Category updated'),
    deleteCategory: makeAction<[string, string], unknown>(([id]) => apiCatalog.deleteCategory(id), ([, name]) => `Category "${name}" deleted`),
    addBrand: makeAction<[string], { id: string }>(([name]) => apiCatalog.createBrand(name), ([name]) => `Brand "${name}" created`),
    updateBrand: makeAction<[string, string], { id: string }>(([id, name]) => apiCatalog.updateBrand(id, name), () => 'Brand updated'),
    deleteBrand: makeAction<[string, string], unknown>(([id]) => apiCatalog.deleteBrand(id), ([, name]) => `Brand "${name}" deleted`),
    addProduct: makeAction<[apiCatalog.ProductInput], { id: string }>(([input]) => apiCatalog.createProduct(input), ([i]) => `Product "${i.name}" created`),
    updateProduct: makeAction<[string, apiCatalog.ProductInput, string?], { id: string }>(([id, input]) => apiCatalog.updateProduct(id, input), ([, , name]) => (name ? `${name} updated` : 'Product updated')),
    deleteProduct: makeAction<[string, string], unknown>(([id]) => apiCatalog.deleteProduct(id), ([, name]) => `Product "${name}" deleted`),
    publishProduct: makeAction<[string, string, boolean], unknown>(([id, publish]) => (publish ? apiCatalog.publishProduct(id) : apiCatalog.unpublishProduct(id)), ([, name, publish]) => `${name} ${publish ? 'published' : 'unpublished'}`),
    addVariant: makeAction<[apiCatalog.VariantInput], { id: string }>(([input]) => apiCatalog.createVariant(input), ([i]) => `Variant ${i.sku} added`),
    updateVariant: makeAction<[string, apiCatalog.VariantInput, string?], { id: string }>(([id, input]) => apiCatalog.updateVariant(id, input), ([, , label]) => (label ? `${label} updated` : 'Variant updated')),
    deleteVariant: makeAction<[string, string], unknown>(([id]) => apiCatalog.deleteVariant(id), ([, sku]) => `Variant ${sku} deleted`),
    addAssortment: makeAction<[string, string], unknown>(([storeId, variantId]) => apiCatalog.addAssortment(storeId, variantId), () => 'Variant listed at store'),
    setPrice: makeAction<[string, string, number, number], { approvalId?: string }>(([storeId, variantId, selling, mrp]) => apiCatalog.setPrice({
      storeId, variantId, sellingPaise: rupeesToPaise(selling), mrpPaise: rupeesToPaise(mrp),
    }), () => 'Price saved'),
    approveCatalogChange: makeAction<[string], unknown>(([approvalId]) => apiCatalog.approveCatalogChange(approvalId), () => 'Catalog change approved'),
    createCatalogImport: makeAction<[string, string, boolean], { id: string }>(([mediaId, storeId, dryRun]) => apiCatalog.createCatalogImport(mediaId, storeId, dryRun), ([, , dryRun]) => (dryRun ? 'Dry run started' : 'Import started')),
    approveCatalogImport: makeAction<[string], unknown>(([approvalId]) => apiCatalog.approveCatalogImport(approvalId), () => 'Import approved — applying'),
  }
}

// ── §4 Inventory ─────────────────────────────────────────────────────────────
export function useInventoryActions() {
  const qc = useQueryClient()
  const inv = () => {
    void qc.invalidateQueries({ queryKey: ['shelf-life'] })
    void qc.invalidateQueries({ queryKey: ['inventory-report'] })
    void qc.invalidateQueries({ queryKey: ['inventory-ledger'] })
    void qc.invalidateQueries({ queryKey: ['inventory-summary'] })
    void qc.invalidateQueries({ queryKey: ['approvals'] })
  }
  const { makeAction } = useActionRunner(inv)
  return {
    setShelfLife: makeAction<[string, number, string, string], unknown>(([categoryId, minSeconds, expectedVersion, reason]) => {
      const key = newIdempotencyKey()
      return apiInventory.shelfLifeSet(key, { categoryId, minSeconds, expectedVersion, reason })
    }, () => 'Shelf-life policy saved'),
    approveAdjustment: makeAction<[string], unknown>(([adjustmentId]) => {
      const key = newIdempotencyKey()
      return apiInventory.approveInventoryAdjustment(key, adjustmentId)
    }, () => 'Adjustment approved'),
  }
}

// ── §5 Orders ────────────────────────────────────────────────────────────────
export function useOrderActions() {
  const qc = useQueryClient()
  const inv = () => {
    void qc.invalidateQueries({ queryKey: ['orders'] })
    void qc.invalidateQueries({ queryKey: ['order-detail'] })
    void qc.invalidateQueries({ queryKey: ['order-timeline'] })
    void qc.invalidateQueries({ queryKey: ['order-payments'] })
    void qc.invalidateQueries({ queryKey: ['dashboard'] })
    void qc.invalidateQueries({ queryKey: ['approvals'] })
  }
  const { makeAction } = useActionRunner(inv)
  return {
    hold: makeAction<[string, string], unknown>(([id, reason]) => apiOrders.setOrderHold(id, true, reason), () => 'Order put on hold'),
    release: makeAction<[string], unknown>(([id]) => apiOrders.setOrderHold(id, false, 'Hold released by admin'), () => 'Hold released'),
    cancel: makeAction<[string, string], unknown>(([id, reason]) => apiOrders.cancelOrder(id, reason), () => 'Order cancelled'),
    resetCode: makeAction<[string, string], unknown>(([id, reason]) => apiOrders.resetDeliveryCode(id, reason), () => 'Delivery code lock reset'),
    reassign: makeAction<[string, string, string], unknown>(([id, riderId, reason]) => {
      const key = newIdempotencyKey()
      return apiOrders.assignRider(key, id, riderId, reason)
    }, () => 'Rider reassigned'),
    resolveAddress: makeAction<[string, string], unknown>(([id, reason]) => {
      const key = newIdempotencyKey()
      return apiOrders.resolveWrongAddress(key, id, reason)
    }, () => 'Wrong-address report resolved'),
    requestRefund: makeAction<[string, number, string], { approvalId: string }>(([id, amountRupees, reason]) => {
      const key = newIdempotencyKey()
      return apiOrders.requestOrderRefund(key, id, rupeesToPaise(amountRupees), reason)
    }, () => 'Refund requested — awaiting approval'),
    requestRepair: makeAction<[string, 'CANCELLED' | 'EXPIRED', string], { approvalId: string }>(([id, state, reason]) => {
      const key = newIdempotencyKey()
      return apiOrders.requestOrderRepair(key, id, state, reason)
    }, () => 'Repair request submitted — awaiting approval'),
    approveOrderApproval: makeAction<[string], unknown>(([approvalId]) => apiOrders.approveOrderApproval(approvalId), () => 'Order approval executed'),
  }
}

// ── §6 People ────────────────────────────────────────────────────────────────
export function usePeopleActions() {
  const qc = useQueryClient()
  const inv = () => {
    void qc.invalidateQueries({ queryKey: ['users'] })
    void qc.invalidateQueries({ queryKey: ['workforce'] })
    void qc.invalidateQueries({ queryKey: ['rider-applications'] })
    void qc.invalidateQueries({ queryKey: ['approvals'] })
    void qc.invalidateQueries({ queryKey: ['store-operations'] })
  }
  const { makeAction } = useActionRunner(inv)
  return {
    blockUser: makeAction<[string, string, boolean], unknown>(([userId, , blocked]) => apiPeople.setUserBlocked(userId, blocked), ([, name, blocked]) => (blocked ? `${name} blocked` : `${name} unblocked`)),
    addWorkforce: makeAction<[{ email: string; name: string; role: 'RIDER' | 'STORE_MANAGER' | 'SUPPORT_AGENT' }], { operationId: string; userId: string }>(([input]) => apiPeople.createWorkforce(input), ([i]) => `Invite sent to ${i.email}`),
    requestPasswordReset: makeAction<[string, string], unknown>(([userId]) => apiPeople.requestUserPasswordReset(userId), ([, name]) => `Password reset requested for ${name}`),
    assignStore: makeAction<[string, string, boolean], unknown>(([userId, storeId, grant]) => apiPeople.assignUserStore(userId, storeId, grant), ([, , grant]) => (grant ? 'Store assigned' : 'Store unassigned')),
    requestRoleChange: makeAction<[string, string, 'RIDER' | 'STORE_MANAGER' | 'SUPPORT_AGENT' | 'SUPER_ADMIN', boolean], { requestId: string }>(([userId, , role, grant]) => apiPeople.requestRoleChange(userId, role, grant), ([, name]) => `Role change for ${name} submitted as approval request`),
    approveRoleChange: makeAction<[string], unknown>(([requestId]) => apiPeople.approveRoleChange(requestId), () => 'Role change approved'),
  }
}

// ── §7 Payments, refunds & wallets ───────────────────────────────────────────
export function usePaymentActions() {
  const qc = useQueryClient()
  const inv = () => {
    void qc.invalidateQueries({ queryKey: ['refunds'] })
    void qc.invalidateQueries({ queryKey: ['payment-attempts'] })
    void qc.invalidateQueries({ queryKey: ['wallet-ledger'] })
    void qc.invalidateQueries({ queryKey: ['reconciliation'] })
    void qc.invalidateQueries({ queryKey: ['invoice-failures'] })
    void qc.invalidateQueries({ queryKey: ['order-payments'] })
    void qc.invalidateQueries({ queryKey: ['order-detail'] })
    void qc.invalidateQueries({ queryKey: ['approvals'] })
    void qc.invalidateQueries({ queryKey: ['dashboard'] })
  }
  const { makeAction } = useActionRunner(inv)
  return {
    retryInvoice: makeAction<[string, string], unknown>(([documentId, reason]) => {
      const key = newIdempotencyKey()
      return apiPayments.retryInvoiceRender(key, documentId, reason)
    }, () => 'Invoice render retry queued'),
    walletAdjust: makeAction<[{ userId: string; bucket: 'cash' | 'promo'; direction: 'CREDIT' | 'DEBIT'; amountRupees: number; reason: string }], { approvalId: string }>(([input]) =>
      apiPayments.requestWalletAdjustment({
        userId: input.userId,
        bucket: input.bucket,
        direction: input.direction,
        amountPaise: signedRupeesToPaise(Math.abs(input.amountRupees)),
        reason: input.reason,
      }), () => 'Wallet adjustment requested — awaiting checker approval'),
    approveWalletAdjustment: makeAction<[string], unknown>(([approvalId]) => apiPayments.approveWalletAdjustment(approvalId), () => 'Wallet adjustment approved'),
    setReconciliationStatus: makeAction<[string, 'ACKNOWLEDGED' | 'DISMISSED' | 'ESCALATED' | 'RESOLVED' | 'REJECTED', string], unknown>(([id, decision, reason]) => apiPayments.reviewReconciliation(id, decision, reason), ([, decision]) => `Finding marked ${decision.toLowerCase()}`),
    recordRefundEvidence: makeAction<[string, string, File], unknown>(([refundReference, paymentReference, file]) => {
      const key = newIdempotencyKey()
      return (async () => {
        const target = await apiPayments.payoutEvidenceTarget(file.type || 'application/pdf', file.size)
        await apiCatalog.uploadToTarget(target, file)
        return apiPayments.markManualRefundPaid(key, refundReference, { paymentReference, evidenceMediaId: target.mediaId })
      })()
    }, () => 'Manual refund evidence recorded'),
  }
}

// ── §8 Payouts ───────────────────────────────────────────────────────────────
export function usePayoutActions() {
  const qc = useQueryClient()
  const inv = () => {
    void qc.invalidateQueries({ queryKey: ['payouts'] })
    void qc.invalidateQueries({ queryKey: ['payout-corrections'] })
    void qc.invalidateQueries({ queryKey: ['approvals'] })
  }
  const { makeAction } = useActionRunner(inv)
  return {
    /** Approval request → execute (maker-checker; server enforces roles). */
    approve: makeAction<[string], { approved: boolean }>(([payoutId]) => (async () => {
      const { approvalId } = await apiPayouts.requestPayoutApproval(payoutId)
      return apiPayouts.executePayoutApproval(approvalId)
    })(), () => 'Payout approved'),
    cancel: makeAction<[string], unknown>(([payoutId]) => apiPayouts.cancelPayout(payoutId), () => 'Payout cancelled'),
    addCorrection: makeAction<[string, number, string, string], { approvalId: string }>(([payoutId, deltaRupees, reason, reference]) => {
      const key = newIdempotencyKey()
      return apiPayouts.requestPayoutCorrection(key, payoutId, {
        deltaPaise: signedRupeesToPaise(deltaRupees),
        reason,
        reference: reference || key,
      })
    }, () => 'Correction requested — awaiting approval'),
    settleCorrection: makeAction<[string, string, File], { settled: boolean }>(([correctionId, paymentReference, file]) => {
      const key = newIdempotencyKey()
      return (async () => {
        const target = await apiPayouts.evidenceTarget(file.type || 'application/pdf', file.size)
        await apiCatalog.uploadToTarget(target, file)
        return apiPayouts.settlePayoutCorrection(key, correctionId, { paymentReference, evidenceMediaId: target.mediaId })
      })()
    }, () => 'Correction settled'),
    /** Mark paid with evidence — recording a settlement does not transfer money. */
    markPaid: makeAction<[string, string, File], { paid: boolean }>(([payoutId, paymentReference, file]) => {
      const key = newIdempotencyKey()
      return (async () => {
        const target = await apiPayouts.evidenceTarget(file.type || 'application/pdf', file.size)
        await apiCatalog.uploadToTarget(target, file)
        return apiPayouts.markPayoutPaid(key, payoutId, { paymentReference, evidenceMediaId: target.mediaId })
      })()
    }, () => 'Payout marked paid (evidence recorded)'),
  }
}

// ── §9 Offers ────────────────────────────────────────────────────────────────
export function useOfferActions() {
  const qc = useQueryClient()
  const inv = () => {
    void qc.invalidateQueries({ queryKey: ['coupons'] })
    void qc.invalidateQueries({ queryKey: ['campaigns'] })
    void qc.invalidateQueries({ queryKey: ['inbox'] })
    void qc.invalidateQueries({ queryKey: ['unread-count'] })
  }
  const { makeAction } = useActionRunner(inv)
  return {
    addCoupon: makeAction<[apiOffers.CouponDraftInput], unknown>(([draft]) => {
      const key = newIdempotencyKey()
      return apiOffers.createCoupon(key, draft)
    }, ([d]) => `Coupon ${d.code} created`),
    updateCoupon: makeAction<[string, apiOffers.CouponPatchInput, string?], unknown>(([id, patch]) => {
      const key = newIdempotencyKey()
      return apiOffers.updateCoupon(key, id, patch)
    }, ([, , code]) => (code ? `Coupon ${code} updated` : 'Coupon updated')),
    addCampaign: makeAction<[apiOffers.CampaignCreateInput], { id: string }>(([input]) => {
      const key = newIdempotencyKey()
      return apiOffers.createCampaign(key, input)
    }, ([i]) => `Campaign "${i.title}" created`),
    markNotificationRead: makeAction<[string?], unknown>(([id]) => (id ? apiOffers.markNotificationRead(id) : apiOffers.markAllNotificationsRead()), () => 'Notifications updated'),
  }
}

// ── §10 Subscriptions ────────────────────────────────────────────────────────
export function useSubscriptionAdminActions() {
  const qc = useQueryClient()
  const inv = () => {
    void qc.invalidateQueries({ queryKey: ['sub-plans'] })
    void qc.invalidateQueries({ queryKey: ['sub-slots'] })
    void qc.invalidateQueries({ queryKey: ['sub-holidays'] })
    void qc.invalidateQueries({ queryKey: ['sub-runs'] })
    void qc.invalidateQueries({ queryKey: ['approvals'] })
  }
  const { makeAction } = useActionRunner(inv)
  return {
    savePlan: makeAction<[string, boolean], unknown>(([variantId, active]) => {
      const key = newIdempotencyKey()
      return apiSubs.saveSubscriptionPlan(key, variantId, active)
    }, () => 'Subscription plan updated'),
    saveSlot: makeAction<[apiSubs.SlotInput], unknown>(([slot]) => {
      const key = newIdempotencyKey()
      return apiSubs.saveSubscriptionSlot(key, slot)
    }, () => 'Delivery slot saved'),
    saveHoliday: makeAction<[string, string, string | null], unknown>(([storeId, date, reason]) => {
      const key = newIdempotencyKey()
      return apiSubs.saveSubscriptionHoliday(key, storeId, date, reason)
    }, () => 'Holiday saved'),
    deleteHoliday: makeAction<[string, string], unknown>(([storeId, date]) => {
      const key = newIdempotencyKey()
      return apiSubs.deleteSubscriptionHoliday(key, storeId, date)
    }, () => 'Holiday removed'),
    retryRun: makeAction<[string], unknown>(([runId]) => {
      const key = newIdempotencyKey()
      return apiSubs.retrySubscriptionRun(key, runId)
    }, () => 'Retry queued for failed generations'),
  }
}

// ── §11 Support ──────────────────────────────────────────────────────────────
export function useSupportActions() {
  const qc = useQueryClient()
  const inv = (ticketId?: string) => {
    void qc.invalidateQueries({ queryKey: ['tickets'] })
    void qc.invalidateQueries({ queryKey: ['ticket'] })
    void qc.invalidateQueries({ queryKey: ['ratings'] })
    void qc.invalidateQueries({ queryKey: ['refunds'] })
    void qc.invalidateQueries({ queryKey: ['approvals'] })
    void qc.invalidateQueries({ queryKey: ['saved-responses'] })
    if (ticketId) void qc.invalidateQueries({ queryKey: ['ticket', ticketId] })
  }
  const { makeAction } = useActionRunner(() => inv())
  return {
    reply: makeAction<[string, string, boolean], { id: string }>(([ticketId, body, internal]) => {
      const key = newIdempotencyKey()
      return apiSupport.sendTicketMessage(key, ticketId, { body, internal })
    }, ([, , internal]) => (internal ? 'Internal note added' : 'Response sent')),
    setStatus: makeAction<[string, 'open' | 'in_progress' | 'resolved' | 'closed'], { updated: boolean }>(([ticketId, status]) => apiSupport.updateTicket(ticketId, { status }), ([, status]) => `Ticket marked ${status}`),
    saveCannedResponse: makeAction<[{ id?: string; label: string; body: string; active: boolean }], { id: string }>(([input]) => apiSupport.saveCannedResponse(input), () => 'Canned response saved'),
    moderate: makeAction<[string, boolean, string], { updated: boolean }>(([ratingId, hide, reason]) => apiSupport.moderateRating(ratingId, hide, reason), ([, hide]) => (hide ? 'Rating hidden' : 'Rating made visible')),
    /** Ticket refund — server may commit directly or return APPROVAL_REQUIRED. */
    requestTicketRefund: makeAction<[string, number, string], { status: 'COMMITTED' | 'APPROVAL_REQUIRED'; approvalId?: string; reference?: string }>(([ticketId, amountRupees, reason]) => {
      const key = newIdempotencyKey()
      return apiSupport.requestTicketRefund(ticketId, { amountPaise: rupeesToPaise(amountRupees), reason, idempotencyKey: key })
    }, () => 'Refund processed or sent for approval'),
    executeTicketRefundApproval: makeAction<[string], unknown>(([approvalId]) => {
      const key = newIdempotencyKey()
      return apiSupport.executeTicketRefundApproval(key, approvalId)
    }, () => 'Refund approval executed'),
    /** Attachment upload: target → PUT (media id usable in messages). */
    uploadAttachment: makeAction<[string, File], { mediaId: string }>(([ticketId, file]) => (async () => {
      const target = await apiSupport.ticketUploadTarget(file.type || 'application/pdf', file.size)
      await apiCatalog.uploadToTarget(target, file)
      return target
    })(), () => 'Attachment uploaded'),
    attachmentUrl: (ticketId: string, mediaId: string) => apiSupport.ticketAttachmentUrl(ticketId, mediaId),
  }
}

// ── §12 Reports ──────────────────────────────────────────────────────────────
export function useExportActions() {
  const qc = useQueryClient()
  const inv = () => {
    void qc.invalidateQueries({ queryKey: ['export-jobs'] })
  }
  const { makeAction } = useActionRunner(inv)
  return {
    /** Create export (Idempotency-Key) — poll the jobs list; download via server URL. */
    createJob: makeAction<[ReportKind, { storeId?: string; from?: string; to?: string }], { id: string }>(([kind, filters]) => {
      const key = newIdempotencyKey()
      return apiReports.createReportExport(key, kind, filters)
    }, () => 'Export queued'),
    downloadJob: async (id: string): Promise<string> => apiReports.reportExportDownload(id),
  }
}

// ── §13 Approvals & compliance ───────────────────────────────────────────────
export function useApprovalActions() {
  const qc = useQueryClient()
  const inv = () => {
    void qc.invalidateQueries({ queryKey: ['approvals'] })
    void qc.invalidateQueries({ queryKey: ['fraud-signals'] })
    void qc.invalidateQueries({ queryKey: ['erasure-requests'] })
    void qc.invalidateQueries({ queryKey: ['legal-holds'] })
    void qc.invalidateQueries({ queryKey: ['users'] })
    void qc.invalidateQueries({ queryKey: ['orders'] })
    void qc.invalidateQueries({ queryKey: ['wallet-ledger'] })
    void qc.invalidateQueries({ queryKey: ['inventory-report'] })
    void qc.invalidateQueries({ queryKey: ['payouts'] })
    void qc.invalidateQueries({ queryKey: ['reconciliation'] })
  }
  const { makeAction } = useActionRunner(inv)
  return {
    reject: makeAction<[string, string], unknown>(([approvalId, reason]) => apiApprovals.rejectApproval(approvalId, 'REJECTED', reason), () => 'Approval rejected'),
    setFraudStatus: makeAction<[string, 'ACKNOWLEDGED' | 'DISMISSED' | 'ESCALATED' | 'RESOLVED' | 'REJECTED', string], unknown>(([id, decision, reason]) => apiApprovals.reviewFraudSignal(id, decision, reason), ([, decision]) => `Fraud signal marked ${decision.toLowerCase()}`),
    retryErasure: makeAction<[string], unknown>(([id]) => apiApprovals.retryErasureRequest(id), () => 'Erasure request re-queued'),
    approveErasure: makeAction<[string], unknown>(([approvalId]) => apiApprovals.approveErasureRequest(approvalId), () => 'Erasure approved'),
    placeHold: makeAction<[string, string], { id: string }>(([userId, reason]) => apiApprovals.createLegalHold(userId, reason), () => 'Legal hold placed'),
    releaseHold: makeAction<[string, string], unknown>(([id, reason]) => apiApprovals.releaseLegalHold(id, reason), () => 'Legal hold released'),
  }
}

// ── §14 Settings & system ────────────────────────────────────────────────────
export function useSystemActions() {
  const qc = useQueryClient()
  const inv = () => {
    void qc.invalidateQueries({ queryKey: ['config'] })
    void qc.invalidateQueries({ queryKey: ['failed-jobs'] })
    void qc.invalidateQueries({ queryKey: ['outbox'] })
  }
  const { makeAction } = useActionRunner(inv)
  const actor = () => useAuth.getState().admin?.email ?? 'admin'
  return {
    updateConfigKey: makeAction<[string, unknown], null>(([key, value]) => apiSettings.updateConfigKey(key, value), ([key]) => `Setting "${key}" saved`),
    updateFlag: makeAction<[string, boolean], null>(([key, enabled]) => apiSettings.updateFeatureFlag(key, enabled), ([key, enabled]) => `Flag "${key}" ${enabled ? 'enabled' : 'disabled'}`),
    retryJob: makeAction<[string, string], unknown>(([concern, id]) => apiApprovals.replayFailedJob(concern, id, `Replayed from admin portal by ${actor()}`), () => 'Job re-queued'),
    replayOutbox: makeAction<[string, string], unknown>(([id, consumer]) => apiApprovals.replayOutbox(id, consumer, `Replayed from admin portal by ${actor()}`), () => 'Outbox row replayed'),
  }
}

// ── Zone polygon helper (used by Stores' PolygonEditor save) ─────────────────
export function zoneGeometryFromPoints(points: [number, number][]): object {
  return pointsToPolygon(points)
}
