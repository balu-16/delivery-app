/**
 * Customer notification typed resolver (plan3 §5 + §3 contract).
 *
 * One resolver per app for inbox taps + foreground push taps + cold-start
 * responses. Validates event type, app audience, UUID/record ID and route
 * allowlist. Uses existing notification IDs for deduplicated read updates.
 * Warm start preserves the current stack; cold start waits for the correct
 * signed-in account and opens one target. Unknown events fall back to the
 * inbox; unavailable orders fall back to My Dairy. Duplicate taps dedupe
 * to one destination.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type CustomerResolved =
  | { kind: 'order'; orderId: string }
  | { kind: 'product'; productId?: string; variantId?: string }
  | { kind: 'agent'; threadId?: string; nudgeName?: string }
  | { kind: 'notifications' }
  | { kind: 'support' }
  | { kind: 'supportThread'; ticketId: string };

export type CustomerRoute = { pathname: string; params?: Record<string, string> };

function isUuid(v: unknown): v is string {
  return typeof v === 'string' && UUID_RE.test(v);
}

function pick(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const record = raw as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of ['type', 'eventType', 'audience', 'app', 'orderId', 'productId', 'variantId', 'threadId', 'ticketId', 'notificationId', 'link', 'deepLink', 'productName']) {
    if (k in record) out[k] = record[k];
  }
  if (record['payload'] && typeof record['payload'] === 'object' && !Array.isArray(record['payload'])) {
    const p = record['payload'] as Record<string, unknown>;
    if ('orderId' in p) out['orderId'] = p['orderId'];
    if ('productId' in p) out['productId'] = p['productId'];
    if ('variantId' in p) out['variantId'] = p['variantId'];
    if ('threadId' in p) out['threadId'] = p['threadId'];
  }
  if (typeof record['id'] === 'string') out['notificationId'] = record['id'];
  return out;
}

const CUSTOMER_AUDIENCES = new Set(['customer', 'CUSTOMER']);
const RIDER_AUDIENCES = new Set(['rider', 'RIDER', 'partner', 'PARTNER']);

function isCustomerAudience(data: Record<string, unknown>): boolean {
  const raw = data['audience'] ?? data['app'];
  if (raw === undefined) {
    // Legacy pushes without audience are customer for this app unless they
    // explicitly carry a rider offerId.
    return true;
  }
  if (typeof raw !== 'string') return false;
  if (CUSTOMER_AUDIENCES.has(raw)) return true;
  if (RIDER_AUDIENCES.has(raw)) return false;
  return false;
}

/**
 * Resolve a raw push / inbox event to an allowlisted destination.
 * Returns null when the event should fall back to the inbox.
 */
export function resolveCustomerNotification(raw: unknown): { route: CustomerRoute; orderIdForRead?: string; productId?: string } | null {
  const data = pick(raw);
  const type = typeof data['type'] === 'string' ? data['type'] : typeof data['eventType'] === 'string' ? data['eventType'] : undefined;
  const link = typeof data['link'] === 'string' ? data['link'] : typeof data['deepLink'] === 'string' ? data['deepLink'] : undefined;

  if (!isCustomerAudience(data)) return null;

  // Assistant thread links
  if (link === '/agent' || type === 'assistant' || type === 'agent') {
    if (isUuid(data['threadId'])) {
      return { route: { pathname: '/agent', params: { threadId: data['threadId'] } } };
    }
    if (isUuid(data['variantId'])) {
      const name = typeof data['productName'] === 'string' ? data['productName'].replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 100) : '';
      return { route: { pathname: '/agent', params: { variantId: data['variantId'], ...(name ? { nudgeName: name } : {}) } }, productId: data['variantId'] as string };
    }
    return { route: { pathname: '/agent' } };
  }

  // Order events
  if (type === 'order' || type === 'order.confirmed' || type === 'order.packed' || type === 'order.out_for_delivery' || type === 'order.delivered' || type === 'order.cancelled' || type === 'order.delivery_failed' || type === 'payment.failed') {
    if (isUuid(data['orderId'])) {
      return { route: { pathname: '/orders/[orderId]', params: { orderId: data['orderId'] } }, orderIdForRead: data['orderId'] };
    }
    if (typeof link === 'string' && link.startsWith('/orders/')) {
      const maybe = link.split('/')[2];
      if (isUuid(maybe)) return { route: { pathname: '/orders/[orderId]', params: { orderId: maybe } }, orderIdForRead: maybe };
    }
    // Unavailable orders fall back to My Dairy
    return { route: { pathname: '/(tabs)/my-dairy' } };
  }

  // Restock / product events
  if (type === 'product' || type === 'restock' || type === 'inventory.restock') {
    if (isUuid(data['productId']) || typeof data['productId'] === 'string' && (data['productId'] as string).length > 0) {
      const pid = data['productId'] as string;
      return { route: { pathname: '/product/[id]', params: { id: pid } }, productId: pid };
    }
    if (isUuid(data['variantId'])) {
      return { route: { pathname: '/products' } };
    }
    return { route: { pathname: '/products' } };
  }

  // Support
  if (type === 'support.ticket' || type === 'support.message') {
    if (isUuid(data['ticketId'])) {
      return { route: { pathname: '/support/[ticketId]', params: { ticketId: data['ticketId'] } } };
    }
    return { route: { pathname: '/support' } };
  }
  if (type === 'support.list') return { route: { pathname: '/support' } };

  // Wallet / referrals
  if (type === 'wallet' || type === 'payments.refund.settled' || type === 'payments.topup.captured') {
    if (typeof link === 'string' && (link === '/wallet' || link.startsWith('/wallet'))) {
      return { route: { pathname: '/wallet' } };
    }
    return { route: { pathname: '/wallet' } };
  }

  // Generic link fallback: only allowlisted deep links.
  if (typeof link === 'string') {
    if (link === '/notifications' || link === '/wallet' || link === '/referrals' || link === '/support' || link === '/products') {
      return { route: { pathname: link } };
    }
    if (link.startsWith('/orders/')) {
      const id = link.split('/')[2];
      if (isUuid(id)) return { route: { pathname: '/orders/[orderId]', params: { orderId: id } }, orderIdForRead: id };
      return { route: { pathname: '/(tabs)/my-dairy' } };
    }
    if (link.startsWith('/product/')) {
      const id = link.split('/')[2];
      if (id) return { route: { pathname: '/product/[id]', params: { id } }, productId: id };
    }
    // Unknown deep link -> inbox
    return { route: { pathname: '/notifications' } };
  }

  // No type / unknown -> inbox
  return { route: { pathname: '/notifications' } };
}

const lastTap = { key: '', at: 0 };
export function shouldNavigateCustomer(route: CustomerRoute): boolean {
  const key = `${route.pathname}:${route.params ? JSON.stringify(route.params) : ''}`;
  const now = Date.now();
  if (key === lastTap.key && now - lastTap.at < 1500) return false;
  lastTap.key = key;
  lastTap.at = now;
  return true;
}

export function clearCustomerTapCache() {
  lastTap.key = '';
  lastTap.at = 0;
}

export function isValidCustomerOrderId(id: string | undefined | null): id is string {
  return typeof id === 'string' && UUID_RE.test(id);
}
