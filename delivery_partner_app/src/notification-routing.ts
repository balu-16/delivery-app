/**
 * Partner notification typed resolver (plan3 §5 + §3 contract).
 *
 * One resolver for inbox taps, foreground push taps and cold-start
 * responses. Validates event type, app audience, UUID/record ID and route
 * allowlist. Payloads carry IDs + minimal display copy only — no delivery
 * codes, addresses, sensitive amounts or precise GPS (frozen contract #3).
 *
 * Unknown events fall back to the inbox; expired offers fall back to Tasks;
 * unavailable tasks fall back to Tasks. Duplicate taps dedupe to one
 * destination. Returns a route descriptor the coordinator navigates to;
 * the coordinator performs the deduplicated read-mark and navigation.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type PartnerRoute =
  | { type: 'offer'; offerId: string }
  | { type: 'task'; taskId: string }
  | { type: 'history'; taskId: string; attemptNo?: number }
  | { type: 'notifications' }
  | { type: 'support' }
  | { type: 'supportThread'; ticketId: string };

export type ResolvedRoute =
  | { kind: 'push'; pathname: string; params?: Record<string, string> }
  | { kind: 'fallback'; pathname: string; reason: 'unknown' | 'expired' | 'unavailable' | 'invalid' };

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

/**
 * Normalise the raw push/inbox data object. We accept both the inbox row
 * shape ({ id, payload, data }) and the raw push content data bag.
 * Only allowlisted keys are read; unknown keys are declined.
 */
function pickData(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const record = raw as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of ['type', 'eventType', 'audience', 'app', 'offerId', 'taskId', 'ticketId', 'notificationId', 'attemptNo']) {
    if (key in record) out[key] = record[key];
  }
  // Inbox rows from GET /v1/rider/notifications nest the same fields under payload/data
  if (record['payload'] && typeof record['payload'] === 'object' && !Array.isArray(record['payload'])) {
    const nested = record['payload'] as Record<string, unknown>;
    if ('offerId' in nested) out['offerId'] = nested['offerId'];
    if ('taskId' in nested) out['taskId'] = nested['taskId'];
    if ('ticketId' in nested) out['ticketId'] = nested['ticketId'];
    if ('attemptNo' in nested) out['attemptNo'] = nested['attemptNo'];
  }
  if (record['data'] && typeof record['data'] === 'object' && !Array.isArray(record['data'])) {
    const nested = record['data'] as Record<string, unknown>;
    if ('offerId' in nested) out['offerId'] = nested['offerId'];
    if ('taskId' in nested) out['taskId'] = nested['taskId'];
    if ('ticketId' in nested) out['ticketId'] = nested['ticketId'];
    if ('attemptNo' in nested) out['attemptNo'] = nested['attemptNo'];
  }
  // NotificationViewDto carries id / notificationId for deduped read updates
  if (typeof record['id'] === 'string') out['notificationId'] = record['id'];
  return out;
}

const RIDER_AUDIENCES = new Set(['rider', 'RIDER', 'partner', 'PARTNER']);
const CUSTOMER_AUDIENCES = new Set(['customer', 'CUSTOMER']);

function isRiderAudience(data: Record<string, unknown>): boolean {
  const raw = data['audience'] ?? data['app'];
  if (raw === undefined) return true; // legacy pushes without audience default to rider for this app
  if (typeof raw !== 'string') return false;
  return RIDER_AUDIENCES.has(raw);
}

/**
 * Resolve a push/inbox event to a router destination.
 *
 * - offer events use offerId -> /offers/[offerId]
 * - assignment events use taskId -> /tasks/[taskId]
 * - history / earnings links use taskId (+ attemptNo) -> /history/[taskId]
 * - support thread events use ticketId -> /support/[ticketId]
 * - everything else / unknown -> /notifications inbox
 */
export function resolvePartnerNotification(raw: unknown): ResolvedRoute {
  const data = pickData(raw);
  const type = typeof data['type'] === 'string' ? data['type'] : typeof data['eventType'] === 'string' ? data['eventType'] : undefined;

  if (!isRiderAudience(data)) {
    return { kind: 'fallback', pathname: '/notifications', reason: 'invalid' };
  }
  if (CUSTOMER_AUDIENCES.has(typeof data['audience'] === 'string' ? data['audience'] as string : '')) {
    return { kind: 'fallback', pathname: '/notifications', reason: 'invalid' };
  }

  // Offer events
  if (type === 'rider.offer' || type === 'rider.offer_created' || type === 'dispatch.rider_offer_created' || type === 'offer.created') {
    if (isUuid(data['offerId'])) {
      return { kind: 'push', pathname: '/offers/[offerId]', params: { offerId: data['offerId'] } };
    }
    return { kind: 'fallback', pathname: '/', reason: 'invalid' };
  }
  if (type === 'rider.offer_revoked' || type === 'rider.offer_revoked' || type === 'offer.revoked') {
    // Revoked offers have no valid destination; fall back to Tasks.
    return { kind: 'fallback', pathname: '/', reason: 'expired' };
  }

  // Current assignment events
  if (type === 'rider.task' || type === 'rider.task_updated' || type === 'task.updated' || type === 'task.cancelled') {
    if (isUuid(data['taskId'])) {
      return { kind: 'push', pathname: '/tasks/[taskId]', params: { taskId: data['taskId'] } };
    }
    return { kind: 'fallback', pathname: '/', reason: 'invalid' };
  }

  // History / earnings links (may carry attemptNo)
  if (type === 'rider.history' || type === 'rider.task_history' || type === 'rider.earning') {
    if (isUuid(data['taskId'])) {
      const attempt = typeof data['attemptNo'] === 'number' && Number.isInteger(data['attemptNo']) && data['attemptNo'] >= 0
        ? String(data['attemptNo'])
        : typeof data['attemptNo'] === 'string' && /^\d+$/.test(data['attemptNo'])
          ? data['attemptNo']
          : undefined;
      const params: Record<string, string> = { taskId: data['taskId'] };
      if (attempt !== undefined) params['attemptNo'] = attempt;
      return { kind: 'push', pathname: '/history/[taskId]', params };
    }
    return { kind: 'fallback', pathname: '/notifications', reason: 'invalid' };
  }

  // Support thread events
  if (type === 'rider.ticket' || type === 'support.ticket' || type === 'support.message') {
    if (isUuid(data['ticketId'])) {
      return { kind: 'push', pathname: '/support/[ticketId]', params: { ticketId: data['ticketId'] } };
    }
    return { kind: 'push', pathname: '/support' };
  }
  if (type === 'support.list' || type === 'rider.support') {
    return { kind: 'push', pathname: '/support' };
  }

  // Document review outcomes land on the partner application page
  if (type === 'rider.document.approved' || type === 'rider.document.rejected' || type === 'identity.rider_document_approved' || type === 'identity.rider_document_rejected') {
    return { kind: 'push', pathname: '/' };
  }

  // Generic notifications -> inbox
  if (type === undefined) {
    // No event type: if IDs are present we can still route; otherwise inbox.
    if (isUuid(data['offerId'])) {
      return { kind: 'push', pathname: '/offers/[offerId]', params: { offerId: data['offerId'] } };
    }
    if (isUuid(data['taskId'])) {
      return { kind: 'push', pathname: '/tasks/[taskId]', params: { taskId: data['taskId'] } };
    }
    if (isUuid(data['ticketId'])) {
      return { kind: 'push', pathname: '/support/[ticketId]', params: { ticketId: data['ticketId'] } };
    }
    return { kind: 'fallback', pathname: '/notifications', reason: 'unknown' };
  }

  return { kind: 'fallback', pathname: '/notifications', reason: 'unknown' };
}

/** Map a resolved route to an expo-router href. */
export function partnerHref(route: ResolvedRoute): { pathname: string; params?: Record<string, string> } {
  if (route.kind === 'fallback') return { pathname: route.pathname };
  return { pathname: route.pathname, ...(route.params ? { params: route.params } : {}) };
}

/**
 * Deduplicate repeat taps to the same record: remember the last
 * navigated href + timestamp; the coordinator calls shouldNavigate()
 * before pushing. Repeat tap to the same record within 1.5s is skipped.
 */
const lastTap = { key: '', at: 0 };
export function shouldNavigate(href: { pathname: string; params?: Record<string, string> }): boolean {
  const key = `${href.pathname}:${href.params ? JSON.stringify(href.params) : ''}`;
  const now = Date.now();
  if (key === lastTap.key && now - lastTap.at < 1500) return false;
  lastTap.key = key;
  lastTap.at = now;
  return true;
}

/** For tests: clear deduplication state. */
export function clearPartnerTapCache() {
  lastTap.key = '';
  lastTap.at = 0;
}

export function isValidPartnerTaskId(id: string | undefined | null): id is string {
  return typeof id === 'string' && UUID_RE.test(id);
}

export function isValidPartnerOfferId(id: string | undefined | null): id is string {
  return typeof id === 'string' && UUID_RE.test(id);
}
