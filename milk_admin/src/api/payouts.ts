import { get, post, buildQuery, sendIdempotent } from './http'
import { lowerStatus } from './mapping'
import { paiseToRupees } from './money'
import type { CursorPage, Payout, PayoutCorrection, UploadTarget } from '@/types'

// ── Rider payouts: list / approval / corrections / cancel / evidence / paid ──

interface PayoutApiRow {
  id: string; rider_id: string; state: string
  gross_paise: string; cash_offset_paise: string; net_paise: string
  created_at: string; approved_at: string | null; paid_at: string | null
}
interface CorrectionApiRow {
  id: string; payout_id: string; delta_paise: string; reason: string; state: string
  created_at: string; settled_at: string | null; payment_reference: string | null
}

function mapPayout(r: PayoutApiRow, riderName: string | null): Payout {
  return {
    id: r.id,
    riderId: r.rider_id,
    riderName,
    gross: paiseToRupees(r.gross_paise),
    cashOffset: paiseToRupees(r.cash_offset_paise),
    net: paiseToRupees(r.net_paise),
    status: lowerStatus(r.state) as Payout['status'],
    createdAt: r.created_at,
    approvedAt: r.approved_at ?? null,
    paidAt: r.paid_at ?? null,
  }
}

const mapCorrection = (r: CorrectionApiRow): PayoutCorrection => ({
  id: r.id,
  payoutId: r.payout_id,
  delta: paiseToRupees(r.delta_paise),
  reason: r.reason,
  state: r.state,
  createdAt: r.created_at,
  settledAt: r.settled_at ?? null,
  paymentReference: r.payment_reference ?? null,
})

/**
 * Payout list — rider names resolve from the fleet roster when available
 * (the payouts table carries only rider ids). Unknown riders render as ids.
 */
export function listPayouts(opts?: { riderNames?: Record<string, string>; cursor?: string; limit?: number }): Promise<CursorPage<Payout>> {
  const qs = buildQuery({ cursor: opts?.cursor, limit: opts?.limit })
  return get<{ items: PayoutApiRow[]; nextCursor: string | null }>(`/v1/admin/payouts${qs}`).then((res) => ({
    items: (res.items ?? []).map((r) => mapPayout(r, opts?.riderNames?.[r.rider_id] ?? null)),
    nextCursor: res.nextCursor ?? null,
  }))
}

/** Approval request → returns the approval id for the checker to execute. */
export const requestPayoutApproval = (payoutId: string) =>
  post<{ approvalId: string }>(`/v1/admin/payouts/${payoutId}/approval`, {})

export const executePayoutApproval = (approvalId: string) =>
  post<{ approved: boolean }>(`/v1/admin/payout-approvals/${approvalId}/execute`, {})

export function listPayoutCorrections(payoutId: string, cursor?: string, limit?: number): Promise<CursorPage<PayoutCorrection>> {
  return get<{ items: CorrectionApiRow[]; nextCursor: string | null }>(
    `/v1/admin/payouts/${payoutId}/corrections${buildQuery({ cursor, limit })}`,
  ).then((res) => ({ items: (res.items ?? []).map(mapCorrection), nextCursor: res.nextCursor ?? null }))
}

export const requestPayoutCorrection = (idempotencyKey: string, payoutId: string, input: {
  deltaPaise: string; reason: string; reference: string
}) => sendIdempotent<{ approvalId: string }>('POST', `/v1/admin/payouts/${payoutId}/corrections`, input, idempotencyKey)

export const settlePayoutCorrection = (idempotencyKey: string, correctionId: string, input: {
  paymentReference: string; evidenceMediaId: string
}) => sendIdempotent<{ settled: boolean }>('POST', `/v1/admin/payout-corrections/${correctionId}/settled`, { ...input, idempotencyKey }, idempotencyKey)

export const cancelPayout = (payoutId: string) => post<{ cancelled: boolean }>(`/v1/admin/payouts/${payoutId}/cancel`, {})

/** Evidence upload target (PAYOUT_EVIDENCE purpose) — PUT upload then mark paid. */
export const evidenceTarget = (contentType: string, size: number) =>
  post<UploadTarget>('/v1/admin/payout-evidence', { contentType, size })

export const markPayoutPaid = (idempotencyKey: string, payoutId: string, input: {
  paymentReference: string; evidenceMediaId: string
}) => sendIdempotent<{ paid: boolean }>('POST', `/v1/admin/payouts/${payoutId}/paid`, { ...input, idempotencyKey }, idempotencyKey)
