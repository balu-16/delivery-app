import { get, post, buildQuery, sendIdempotent } from './http'
import { lowerStatus } from './mapping'
import { paiseToRupees } from './money'
import type { CursorPage, InvoiceRenderFailure, PaymentAttempt, ReconciliationFinding, RefundRow, UploadTarget } from '@/types'

// ── Payments: attempts / refunds / wallet / reconciliation / invoice failures ─

interface AttemptApiRow {
  attemptId: string; orderId: string; operationReference: string; kind: string
  gatewayPaymentId: string | null; amountPaise: string; currency: string; status: string; createdAt: string
}
interface RefundApiRow {
  refundId: string; refundReference: string; orderId: string; sourceType: string
  amountPaise: string; destination: string; status: string; gatewayRefundId: string | null; reason: string | null
}
interface LedgerApiRow {
  id: string; userId: string; bucket: 'cash' | 'promo'; deltaPaise: string; reason: string
  refType: string; refId: string; balanceAfter: string; createdAt: string
}
interface ReconApiRow {
  id: string; kind: string; severity: string; aggregate_type: string; aggregate_id: string
  reference: string; details: Record<string, unknown>; status: string
  resolved_by: string | null; resolved_at: string | null; created_at: string
}

const mapAttempt = (r: AttemptApiRow): PaymentAttempt => ({
  attemptId: r.attemptId,
  orderId: r.orderId,
  operationReference: r.operationReference,
  kind: r.kind,
  gatewayPaymentId: r.gatewayPaymentId ?? null,
  amount: paiseToRupees(r.amountPaise),
  currency: r.currency,
  status: lowerStatus(r.status) as PaymentAttempt['status'],
  createdAt: r.createdAt,
})

const mapRefund = (r: RefundApiRow): RefundRow => ({
  refundId: r.refundId,
  refundReference: r.refundReference,
  orderId: r.orderId,
  sourceType: r.sourceType,
  amount: paiseToRupees(r.amountPaise),
  destination: r.destination,
  status: lowerStatus(r.status) as RefundRow['status'],
  gatewayRefundId: r.gatewayRefundId ?? null,
  reason: r.reason ?? null,
})

const mapRecon = (r: ReconApiRow): ReconciliationFinding => ({
  id: r.id,
  kind: r.kind,
  severity: r.severity,
  aggregateType: r.aggregate_type,
  aggregateId: r.aggregate_id,
  reference: r.reference,
  details: r.details ?? {},
  status: lowerStatus(r.status) as ReconciliationFinding['status'],
  resolvedBy: r.resolved_by ?? null,
  resolvedAt: r.resolved_at ?? null,
  createdAt: r.created_at,
})

/** Payment attempts — pinned new endpoint with filters + cursor. */
export function listPaymentAttempts(filters?: {
  storeId?: string; status?: string; method?: string; from?: string; to?: string
  search?: string; cursor?: string; limit?: number
}): Promise<CursorPage<PaymentAttempt>> {
  const qs = buildQuery({
    storeId: filters?.storeId,
    status: filters?.status?.toUpperCase(),
    method: filters?.method?.toUpperCase(),
    from: filters?.from,
    to: filters?.to,
    search: filters?.search,
    cursor: filters?.cursor,
    limit: filters?.limit,
  })
  return get<{ items: AttemptApiRow[]; nextCursor: string | null }>(`/v1/admin/payments/attempts${qs}`).then((res) => ({
    items: (res.items ?? []).map(mapAttempt),
    nextCursor: res.nextCursor ?? null,
  }))
}

/** Refunds — pinned new endpoint with the same filter family. */
export function listRefunds(filters?: {
  storeId?: string; status?: string; method?: string; from?: string; to?: string
  search?: string; cursor?: string; limit?: number
}): Promise<CursorPage<RefundRow>> {
  const qs = buildQuery({
    storeId: filters?.storeId,
    status: filters?.status?.toUpperCase(),
    method: filters?.method?.toUpperCase(),
    from: filters?.from,
    to: filters?.to,
    search: filters?.search,
    cursor: filters?.cursor,
    limit: filters?.limit,
  })
  return get<{ items: RefundApiRow[]; nextCursor: string | null }>(`/v1/admin/refunds${qs}`).then((res) => ({
    items: (res.items ?? []).map(mapRefund),
    nextCursor: res.nextCursor ?? null,
  }))
}

// ── Wallet ledger (admin view) ───────────────────────────────────────────────
export function walletLedger(filters?: {
  userId?: string; bucket?: 'cash' | 'promo'; reason?: string; cursor?: string; limit?: number
}): Promise<CursorPage<import('@/types').WalletLedgerRow>> {
  const qs = buildQuery({
    userId: filters?.userId,
    bucket: filters?.bucket,
    reason: filters?.reason?.toUpperCase(),
    cursor: filters?.cursor,
    limit: filters?.limit,
  })
  return get<{ items: LedgerApiRow[]; nextCursor: string | null }>(`/v1/admin/wallet/ledger${qs}`).then((res) => ({
    items: (res.items ?? []).map((r) => ({
      id: r.id,
      userId: r.userId,
      bucket: r.bucket,
      delta: paiseToRupees(r.deltaPaise),
      reason: r.reason as import('@/types').WalletReason,
      refType: r.refType,
      refId: r.refId,
      balanceAfter: paiseToRupees(r.balanceAfter),
      createdAt: r.createdAt,
    })),
    nextCursor: res.nextCursor ?? null,
  }))
}

/** Maker-checker wallet adjustment — returns the approval for the checker. */
export const requestWalletAdjustment = (input: {
  userId: string; bucket: 'cash' | 'promo'; direction: 'CREDIT' | 'DEBIT'
  amountPaise: string; reason: string
}) => post<{ approvalId: string }>('/v1/admin/wallet/adjustments', input)

export const approveWalletAdjustment = (approvalId: string) =>
  post<unknown>(`/v1/admin/wallet/adjustments/${approvalId}/approve`, {})

// ── Reconciliation ───────────────────────────────────────────────────────────
export function listReconciliation(limit = 50, cursor?: string): Promise<CursorPage<ReconciliationFinding>> {
  return get<{ items: ReconApiRow[]; nextCursor: string | null }>(`/v1/admin/payments/reconciliation${buildQuery({ limit, cursor })}`).then((res) => ({
    items: (res.items ?? []).map(mapRecon),
    nextCursor: res.nextCursor ?? null,
  }))
}

export const getReconciliationDetail = (id: string) =>
  get<ReconApiRow>(`/v1/admin/payments/reconciliation/${id}`).then(mapRecon)

export const reviewReconciliation = (id: string, decision: 'ACKNOWLEDGED' | 'DISMISSED' | 'ESCALATED' | 'RESOLVED' | 'REJECTED', reason: string) =>
  post<unknown>(`/v1/admin/payments/reconciliation/${id}/review`, { decision, reason })

// ── Invoice render failures ──────────────────────────────────────────────────
export function listInvoiceFailures(limit = 50, cursor?: string): Promise<CursorPage<InvoiceRenderFailure>> {
  return get<{ items: Array<{ documentId: string; number: string; attempts: number; suspendedAt: string }>; nextCursor: string | null }>(
    `/v1/admin/invoices/render-failures${buildQuery({ limit, cursor })}`,
  ).then((res) => ({
    items: (res.items ?? []).map((r) => ({ documentId: r.documentId, number: r.number, attempts: r.attempts, suspendedAt: r.suspendedAt })),
    nextCursor: res.nextCursor ?? null,
  }))
}

/** Idempotent render retry — server may reject until the cause is fixed. */
export const retryInvoiceRender = (idempotencyKey: string, documentId: string, reason: string) =>
  sendIdempotent<{ documentId: string; status: 'PENDING' }>('POST', `/v1/admin/invoices/${documentId}/render-retry`, { reason }, idempotencyKey)

// ── Manual refund settlement (evidence-backed) ───────────────────────────────
export const markManualRefundPaid = (idempotencyKey: string, reference: string, input: {
  paymentReference: string; evidenceMediaId: string
}) => sendIdempotent<unknown>('POST', `/v1/admin/refunds/${encodeURIComponent(reference)}/manual-paid`, { ...input, idempotencyKey }, idempotencyKey)

/** Private upload target for payout/refund evidence (PUT upload then assert). */
export const payoutEvidenceTarget = (contentType: string, size: number) =>
  post<UploadTarget>('/v1/admin/payout-evidence', { contentType, size })
