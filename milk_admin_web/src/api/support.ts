import { get, post, patch, buildQuery, sendIdempotent } from './http'
import { lowerStatus } from './mapping'
import type { CursorPage, RatingRow, SavedResponse, TicketDetail, TicketListItem, TicketStatus, UploadTarget } from '@/types'

// ── Support: tickets / messages / canned responses / attachments / ratings ───

interface TicketListRow {
  id: string; order_id?: string | null; category: string; status: string
  assignee_id?: string | null; created_at: string; updated_at?: string | null
}

function mapTicket(r: TicketListRow): TicketListItem {
  return {
    id: r.id,
    orderId: r.order_id ?? null,
    category: r.category,
    status: lowerStatus(r.status) as TicketStatus,
    assigneeId: r.assignee_id ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at ?? null,
  }
}

export function listTickets(cursor?: string, limit = 50): Promise<CursorPage<TicketListItem>> {
  return get<{ items: TicketListRow[]; nextCursor: string | null }>(`/v1/admin/tickets${buildQuery({ cursor, limit })}`).then((res) => ({
    items: (res.items ?? []).map(mapTicket),
    nextCursor: res.nextCursor ?? null,
  }))
}

interface MessageRow {
  id: string; author_id: string; body: string; internal?: boolean
  created_at: string; attachments?: string[]
}

export function getTicket(id: string, cursor?: string, limit = 100): Promise<TicketDetail> {
  return get<{ ticket: TicketListRow & { owner_id: string; first_response_due_at?: string | null; resolution_due_at?: string | null }; messages: MessageRow[]; nextMessagesCursor: string | null }>(
    `/v1/admin/tickets/${id}${buildQuery({ cursor, limit })}`,
  ).then((res) => ({
    ticket: {
      ...mapTicket(res.ticket),
      ownerId: res.ticket.owner_id,
      firstResponseDueAt: res.ticket.first_response_due_at ?? null,
      resolutionDueAt: res.ticket.resolution_due_at ?? null,
    },
    messages: (res.messages ?? []).map((m) => ({
      id: m.id,
      authorId: m.author_id,
      isOwner: m.author_id === res.ticket.owner_id,
      body: m.body,
      internal: !!m.internal,
      createdAt: m.created_at,
      attachments: m.attachments ?? [],
    })),
    nextMessagesCursor: res.nextMessagesCursor ?? null,
  }))
}

/** Reply — customer-visible by default; internal=true stores a staff-only note. */
export const sendTicketMessage = (idempotencyKey: string, ticketId: string, input: {
  body: string; internal?: boolean; mediaIds?: string[]
}) => sendIdempotent<{ id: string }>('POST', `/v1/admin/tickets/${ticketId}/messages`, { ...input, reference: idempotencyKey }, idempotencyKey)

export const updateTicket = (ticketId: string, input: { status?: TicketStatus; assigneeId?: string | null }) =>
  patch<{ updated: boolean }>(`/v1/admin/tickets/${ticketId}`, {
    status: input.status ? input.status.toUpperCase() : undefined,
    assigneeId: input.assigneeId,
  })

export const ticketUploadTarget = (contentType: string, size: number) =>
  post<UploadTarget>('/v1/admin/ticket-attachments', { contentType, size })

/** Presigned download URL for a ticket attachment. */
export const ticketAttachmentUrl = (ticketId: string, mediaId: string) =>
  get<{ url: string }>(`/v1/admin/tickets/${ticketId}/attachments/${mediaId}`).then((r) => r.url)

// ── Canned responses ─────────────────────────────────────────────────────────
export function listCannedResponses(cursor?: string, limit = 50): Promise<CursorPage<SavedResponse>> {
  return get<{ items: Array<{ id: string; label: string; body: string }>; nextCursor: string | null }>(
    `/v1/admin/canned-responses${buildQuery({ cursor, limit })}`,
  ).then((res) => ({
    items: (res.items ?? []).map((r) => ({ id: r.id, label: r.label, body: r.body })),
    nextCursor: res.nextCursor ?? null,
  }))
}

export const saveCannedResponse = (input: { id?: string; label: string; body: string; active: boolean }) =>
  post<{ id: string }>('/v1/admin/canned-responses', input)

// ── Ratings moderation ───────────────────────────────────────────────────────
interface RatingApiRow {
  id: string; targetType?: string; targetId?: string; stars?: number; comment?: string | null
  hidden?: boolean; needsModeration?: boolean; moderationRequired?: boolean; createdAt?: string
}

function mapRating(r: RatingApiRow): RatingRow {
  return {
    id: r.id,
    targetType: (r.targetType ?? 'ORDER') as RatingRow['targetType'],
    targetId: r.targetId ?? '',
    stars: r.stars ?? 0,
    comment: r.comment ?? null,
    hidden: !!r.hidden,
    needsModeration: !!(r.needsModeration ?? r.moderationRequired),
    createdAt: r.createdAt ?? new Date(0).toISOString(),
  }
}

/** Ratings list — queueOnly=true returns only items flagged for moderation (pinned new endpoint). */
export function listRatings(queueOnly = false, cursor?: string, limit = 50): Promise<CursorPage<RatingRow>> {
  return get<{ items: RatingApiRow[]; nextCursor: string | null }>(`/v1/admin/ratings${buildQuery({ queueOnly: queueOnly || undefined, cursor, limit })}`).then((res) => ({
    items: (res.items ?? []).map(mapRating),
    nextCursor: res.nextCursor ?? null,
  }))
}

export const moderateRating = (ratingId: string, hidden: boolean, reason: string) =>
  patch<{ updated: boolean }>(`/v1/admin/ratings/${ratingId}/moderation`, { hidden, reason })

// ── Ticket refunds (maker-checker) ───────────────────────────────────────────
export const requestTicketRefund = (ticketId: string, input: {
  amountPaise: string; reason: string; idempotencyKey: string
}): Promise<{ status: 'COMMITTED' | 'APPROVAL_REQUIRED'; approvalId?: string; reference?: string }> =>
  post(`/v1/admin/tickets/${ticketId}/refunds`, {
    amountPaise: input.amountPaise,
    reason: input.reason,
    idempotencyKey: input.idempotencyKey,
  })

export const executeTicketRefundApproval = (idempotencyKey: string, approvalId: string) =>
  sendIdempotent<{ approved: boolean }>('POST', `/v1/admin/ticket-refund-approvals/${approvalId}/execute`, {}, idempotencyKey)
