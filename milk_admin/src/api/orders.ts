import { get, post, buildQuery, sendIdempotent } from './http'
import { lowerStatus } from './mapping'
import { paiseToRupees } from './money'
import type {
  CursorPage, FleetSnapshot, InvoiceInfo, Order, OrderDetailData, OrderItem, OrderPaymentMethod,
  OrderPaymentStatus, OrderRefund, OrderStatus, RiderCandidate, TimelineEntry,
} from '@/types'

// ── Orders: list / detail / timeline / payments / actions / fleet / invoice ──

type ApiOrderStatus =
  | 'PENDING_PAYMENT' | 'CONFIRMED' | 'PICKING' | 'PACKED' | 'OUT_FOR_DELIVERY' | 'DELIVERED'
  | 'PAYMENT_FAILED' | 'EXPIRED' | 'CANCELLED' | 'DELIVERY_FAILED' | 'RETURNED_TO_STORE'

interface OrderItemRow {
  id: string; variantId: string; name: string; orderedQty: string; fulfilledQty: string
  shortQty: string; unitPricePaise: string; taxPaise: string; lineStatus: string
}
interface FeeRow { kind: string; amountPaise: string; taxPaise: string; taxSplit: string | null }
interface OrderRow {
  orderId: string; orderNumber: string; userId: string; storeId: string; status: ApiOrderStatus
  onHold: boolean; paymentStatus: string; paymentMethod: 'GATEWAY' | 'WALLET' | 'COD' | 'ZERO_DUE' | null
  subtotalPaise: string; discountPaise: string; feeTotalPaise: string; taxTotalPaise: string
  tipPaise: string; totalPaise: string; walletPromoPaise: string; walletCashPaise: string
  amountDuePaise: string; currency: string; placedAt: string; expiresAt: string | null
  confirmedAt: string | null; deliveredAt: string | null; cancelReason: string | null
  items: OrderItemRow[]; fees: FeeRow[]; metadata: Record<string, unknown>; version: string
}
interface HoldRow { held: boolean; reason: string | null; actorId: string | null; heldAt: string | null }

const num = (s: string | null | undefined) => (s == null ? 0 : Number(s) || 0)

export function mapOrderStatus(s: string): OrderStatus {
  return s.toLowerCase() as OrderStatus
}

export function mapOrder(r: OrderRow): Order {
  const items: OrderItem[] = (r.items ?? []).map((it) => ({
    id: it.id,
    variantId: it.variantId,
    name: it.name,
    qty: num(it.orderedQty),
    unitPrice: paiseToRupees(it.unitPricePaise),
    lineStatus: it.lineStatus,
  }))
  const fees = (r.fees ?? []).map((f) => ({ kind: f.kind as Order['fees'][number]['kind'], amount: paiseToRupees(f.amountPaise) }))
  return {
    id: r.orderId,
    orderNumber: r.orderNumber,
    userId: r.userId,
    storeId: r.storeId,
    status: mapOrderStatus(r.status),
    onHold: !!r.onHold,
    paymentStatus: (r.paymentStatus ?? '').toLowerCase() as OrderPaymentStatus,
    paymentMethod: r.paymentMethod ? (r.paymentMethod.toLowerCase() as OrderPaymentMethod) : null,
    subtotal: paiseToRupees(r.subtotalPaise),
    discount: paiseToRupees(r.discountPaise),
    feeTotal: paiseToRupees(r.feeTotalPaise),
    taxTotal: paiseToRupees(r.taxTotalPaise),
    tip: paiseToRupees(r.tipPaise),
    total: paiseToRupees(r.totalPaise),
    amountDue: paiseToRupees(r.amountDuePaise),
    currency: r.currency,
    placedAt: r.placedAt,
    expiresAt: r.expiresAt ?? null,
    confirmedAt: r.confirmedAt ?? null,
    deliveredAt: r.deliveredAt ?? null,
    cancelReason: r.cancelReason ?? null,
    items,
    fees,
  }
}

export interface OrderListFilters {
  storeId?: string
  userId?: string
  status?: OrderStatus
  placedAfter?: string
  limit?: number
  cursor?: string
}

export function listOrders(filters: OrderListFilters): Promise<CursorPage<Order>> {
  const qs = buildQuery({
    storeId: filters.storeId,
    userId: filters.userId,
    status: filters.status ? filters.status.toUpperCase() : undefined,
    placedAfter: filters.placedAfter,
    limit: filters.limit,
    cursor: filters.cursor,
  })
  return get<{ items: OrderRow[]; nextCursor: string | null }>(`/v1/admin/orders${qs}`).then((res) => ({
    items: (res.items ?? []).map(mapOrder),
    nextCursor: res.nextCursor ?? null,
  }))
}

export function getOrderDetail(id: string): Promise<OrderDetailData> {
  return get<OrderRow & { hold: HoldRow }>(`/v1/admin/orders/${id}`).then((r) => ({
    ...mapOrder(r),
    hold: {
      held: !!r.hold?.held,
      reason: r.hold?.reason ?? null,
      actorId: r.hold?.actorId ?? null,
      heldAt: r.hold?.heldAt ?? null,
    },
  }))
}

export function getOrderTimeline(id: string): Promise<TimelineEntry[]> {
  return get<readonly TimelineEntry[]>(`/v1/admin/orders/${id}/timeline`).then((rows) => [...(rows ?? [])])
}

export interface AttemptRow {
  attemptId: string; orderId: string; operationReference: string
  kind: 'ORDER_PAYMENT' | 'WALLET_TOPUP' | 'ORDER_REFUND' | 'WALLET_REFUND'
  gatewayOrderId: string | null; gatewayPaymentId: string | null
  amountPaise: string; currency: string; status: string; createdAt: string
}
interface RefundApiRow {
  refundId: string; refundReference: string; orderId: string; sourceType: string; sourceId: string
  amountPaise: string; destination: string; status: string; gatewayRefundId: string | null; reason: string | null
}

export function mapRefund(r: RefundApiRow): OrderRefund {
  return {
    refundId: r.refundId,
    refundReference: r.refundReference,
    orderId: r.orderId,
    sourceType: r.sourceType as OrderRefund['sourceType'],
    sourceId: r.sourceId,
    amount: paiseToRupees(r.amountPaise),
    destination: r.destination as OrderRefund['destination'],
    status: lowerStatus(r.status) as OrderRefund['status'],
    gatewayRefundId: r.gatewayRefundId ?? null,
    reason: r.reason ?? null,
  }
}

export function getOrderPayments(id: string): Promise<{ attempts: OrderAttempt[]; refunds: OrderRefund[] }> {
  return get<{ attempts: AttemptRow[]; refunds: RefundApiRow[] }>(`/v1/admin/orders/${id}/payments`).then((res) => ({
    attempts: (res.attempts ?? []).map(mapAttempt),
    refunds: (res.refunds ?? []).map(mapRefund),
  }))
}

export type OrderAttempt = {
  attemptId: string
  orderId: string
  operationReference: string
  kind: string
  gatewayOrderId: string | null
  gatewayPaymentId: string | null
  amount: number
  currency: string
  status: 'created' | 'authorized' | 'captured' | 'failed' | 'unknown'
  createdAt: string
}

function mapAttempt(r: AttemptRow): OrderAttempt {
  return {
    attemptId: r.attemptId,
    orderId: r.orderId,
    operationReference: r.operationReference,
    kind: r.kind,
    gatewayOrderId: r.gatewayOrderId ?? null,
    gatewayPaymentId: r.gatewayPaymentId ?? null,
    amount: paiseToRupees(r.amountPaise),
    currency: r.currency,
    status: lowerStatus(r.status) as OrderAttempt['status'],
    createdAt: r.createdAt,
  }
}

// ── Order actions ────────────────────────────────────────────────────────────
export const cancelOrder = (id: string, reason: string) => post<unknown>(`/v1/admin/orders/${id}/cancel`, { reason })

export const setOrderHold = (id: string, held: boolean, reason: string) =>
  post<{ held: boolean }>(`/v1/admin/orders/${id}/hold`, { held, reason })

export const resetDeliveryCode = (id: string, reason: string) =>
  post<{ state: string }>(`/v1/admin/orders/${id}/delivery-code/reset`, { reason })

export const requestOrderRefund = (idempotencyKey: string, id: string, amountPaise: string, reason: string) =>
  sendIdempotent<{ approvalId: string }>('POST', `/v1/admin/orders/${id}/refunds`, { amountPaise, reason }, idempotencyKey)

export const requestOrderRepair = (idempotencyKey: string, id: string, state: 'CANCELLED' | 'EXPIRED', reason: string) =>
  sendIdempotent<{ approvalId: string }>('POST', `/v1/admin/orders/${id}/force-state`, { state, reason }, idempotencyKey)

export const approveOrderApproval = (id: string) => post<{ state: string }>(`/v1/admin/order-approvals/${id}/approve`)

export const assignRider = (idempotencyKey: string, orderId: string, riderId: string, reason: string) =>
  sendIdempotent<unknown>('POST', `/v1/admin/orders/${orderId}/reassign-rider`, { riderId, reason }, idempotencyKey)

export const resolveWrongAddress = (idempotencyKey: string, orderId: string, reason: string) =>
  sendIdempotent<unknown>('POST', `/v1/admin/orders/${orderId}/wrong-address/resolve`, { reason }, idempotencyKey)

/** Rider candidates — pinned new endpoint; eligibility decided server-side. */
export function riderCandidates(orderId: string): Promise<RiderCandidate[]> {
  return get<{ items: RiderCandidate[] }>(`/v1/admin/orders/${orderId}/rider-candidates`).then((res) => res.items ?? [])
}

/** Presigned invoice — 404 INVOICE_NOT_FOUND / 409 INVOICE_NOT_RENDERED surface honestly. */
export function getOrderInvoice(orderId: string): Promise<InvoiceInfo> {
  return get<InvoiceInfo>(`/v1/admin/orders/${orderId}/invoice`)
}

// ── Fleet map — pinned new endpoint ──────────────────────────────────────────
export function getFleet(): Promise<FleetSnapshot> {
  return get<FleetSnapshot>('/v1/admin/delivery/fleet').then((res) => ({
    items: res.items ?? [],
    freshnessSeconds: res.freshnessSeconds ?? 60,
  }))
}
