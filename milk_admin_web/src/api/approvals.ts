import { get, post, buildQuery, sendIdempotent } from './http'
import { lowerStatus } from './mapping'
import type {
  Approval, CursorPage, ErasureRequest, FailedJob, FraudSignal, FraudSignalDetail, LegalHold,
  OutboxStatus, ReconciliationFinding,
} from '@/types'

// ── Approvals & compliance: approvals / fraud / erasure / legal holds / ops ──

interface ApprovalApiRow {
  id: string; action: string; maker_id: string; checker_id: string | null
  required_role: string; status: string; expires_at: string; created_at: string
}

function mapApproval(r: ApprovalApiRow): Approval {
  return {
    id: r.id,
    action: r.action,
    makerId: r.maker_id,
    checkerId: r.checker_id ?? null,
    requiredRole: r.required_role,
    status: lowerStatus(r.status) as Approval['status'],
    expiresAt: r.expires_at,
    createdAt: r.created_at,
  }
}

export function listApprovals(cursor?: string, limit = 50): Promise<CursorPage<Approval>> {
  return get<{ items: ApprovalApiRow[]; nextCursor: string | null }>(`/v1/admin/approvals${buildQuery({ cursor, limit })}`).then((res) => ({
    items: (res.items ?? []).map(mapApproval),
    nextCursor: res.nextCursor ?? null,
  }))
}

export const getApproval = (id: string) => get<ApprovalApiRow>(`/v1/admin/approvals/${id}`).then(mapApproval)

/** Reject an approval (domain execute endpoints handle the "approve" side). */
export const rejectApproval = (id: string, decision: 'REJECTED', reason: string) =>
  post<unknown>(`/v1/admin/approvals/${id}/reject`, { decision, reason })

// ── Fraud signals ────────────────────────────────────────────────────────────
interface FraudApiRow {
  id: string; kind: string; severity: string; status: string; created_at: string
  user_id?: string | null; reference?: string; details?: Record<string, unknown>
  reviewed_by?: string | null; reviewed_at?: string | null
}

function mapFraud(r: FraudApiRow): FraudSignal {
  return {
    id: r.id,
    kind: r.kind,
    severity: r.severity,
    status: lowerStatus(r.status),
    createdAt: r.created_at,
  }
}

export function listFraudSignals(cursor?: string, limit = 50): Promise<CursorPage<FraudSignal>> {
  return get<{ items: FraudApiRow[]; nextCursor: string | null }>(`/v1/admin/fraud-signals${buildQuery({ cursor, limit })}`).then((res) => ({
    items: (res.items ?? []).map(mapFraud),
    nextCursor: res.nextCursor ?? null,
  }))
}

export function getFraudSignal(id: string): Promise<FraudSignalDetail> {
  return get<FraudApiRow>(`/v1/admin/fraud-signals/${id}`).then((r) => ({
    ...mapFraud(r),
    userId: r.user_id ?? null,
    reference: r.reference ?? '',
    details: r.details ?? {},
    reviewedBy: r.reviewed_by ?? null,
    reviewedAt: r.reviewed_at ?? null,
  }))
}

export const reviewFraudSignal = (id: string, decision: 'ACKNOWLEDGED' | 'DISMISSED' | 'ESCALATED' | 'RESOLVED' | 'REJECTED', reason: string) =>
  post<unknown>(`/v1/admin/fraud-signals/${id}/review`, { decision, reason })

// ── Erasure requests ─────────────────────────────────────────────────────────
interface ErasureApiRow {
  id: string; user_id: string; status: string; blockers: string[]
  created_at: string; updated_at: string
}

function mapErasure(r: ErasureApiRow): ErasureRequest {
  return {
    id: r.id,
    userId: r.user_id,
    status: lowerStatus(r.status) as ErasureRequest['status'],
    blockers: r.blockers ?? [],
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

export function listErasureRequests(cursor?: string, limit = 50): Promise<CursorPage<ErasureRequest>> {
  return get<{ items: ErasureApiRow[]; nextCursor: string | null }>(`/v1/admin/erasure-requests${buildQuery({ cursor, limit })}`).then((res) => ({
    items: (res.items ?? []).map(mapErasure),
    nextCursor: res.nextCursor ?? null,
  }))
}

export const getErasureRequest = (id: string) => get<ErasureApiRow>(`/v1/admin/erasure-requests/${id}`).then(mapErasure)
export const retryErasureRequest = (id: string) => post<unknown>(`/v1/admin/erasure-requests/${id}/retry`, {})
export const approveErasureRequest = (approvalId: string) => post<unknown>(`/v1/admin/erasure-approvals/${approvalId}/approve`, {})
export const requestWorkforceErasure = (userId: string) => post<{ approvalId: string }>(`/v1/admin/users/${userId}/erasure-requests`, {})

// ── Legal holds ──────────────────────────────────────────────────────────────
interface HoldApiRow {
  id: string; user_id: string; reason: string; created_at: string; released_at: string | null
}

function mapHold(r: HoldApiRow): LegalHold {
  return {
    id: r.id,
    userId: r.user_id,
    reason: r.reason,
    createdAt: r.created_at,
    releasedAt: r.released_at ?? null,
  }
}

/** Legal holds list — pinned new endpoint GET /v1/admin/legal-holds. */
export function listLegalHolds(cursor?: string, limit = 50): Promise<CursorPage<LegalHold>> {
  return get<{ items: HoldApiRow[]; nextCursor: string | null }>(`/v1/admin/legal-holds${buildQuery({ cursor, limit })}`).then((res) => ({
    items: (res.items ?? []).map(mapHold),
    nextCursor: res.nextCursor ?? null,
  }))
}

export const createLegalHold = (userId: string, reason: string) =>
  post<{ id: string }>(`/v1/admin/users/${userId}/legal-holds`, { reason })

export const releaseLegalHold = (id: string, reason: string) =>
  post<unknown>(`/v1/admin/legal-holds/${id}/release`, { reason })

// ── Ops: failed jobs + outbox ────────────────────────────────────────────────
export function listFailedJobs(concern: string): Promise<FailedJob[]> {
  return get<Array<{ id: string; name: string; attempts: number; failedAt?: number | string }>>(`/v1/admin/ops/failed-jobs/${concern}`).then((rows) =>
    (rows ?? []).map((r) => ({
      id: r.id,
      name: r.name,
      attempts: r.attempts,
      failedAt: typeof r.failedAt === 'number' ? new Date(r.failedAt).toISOString() : (r.failedAt ?? null),
    })),
  )
}

export const replayFailedJob = (concern: string, id: string, reason: string) =>
  post<unknown>(`/v1/admin/ops/failed-jobs/${concern}/${id}/replay`, { reason })

export function outboxStatus(): Promise<OutboxStatus> {
  return get<{ pending: string; suspended: string; oldest_pending: string | null; latest_processed: string | null }>('/v1/admin/ops/outbox').then((r) => ({
    pending: Number(r.pending ?? '0') || 0,
    suspended: Number(r.suspended ?? '0') || 0,
    oldestPending: r.oldest_pending ?? null,
    latestProcessed: r.latest_processed ?? null,
  }))
}

export const replayOutbox = (id: string, consumer: string, reason: string) =>
  post<unknown>(`/v1/admin/ops/outbox/${id}/${consumer}/replay`, { reason })

// ── Reconciliation detail is used by the approvals page too ──────────────────
export type { ReconciliationFinding }

// ── Shared approval-execute helper for domain executors that are pure idempotent POSTs ──
export const executeIdempotentApproval = (path: string, idempotencyKey: string) =>
  sendIdempotent<unknown>('POST', path, {}, idempotencyKey)
