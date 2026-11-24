import { ApiError } from '../api/client';

export const ORDER_CONFIRMATION_WAIT = 'Please wait while we confirm your order.';
export type CheckoutPhase = 'idle' | 'reviewing' | 'placing' | 'checking' | 'uncertain';

/**
 * Explicit client phases derived from the existing `checkoutPhase`,
 * `checkoutError`, and `lastOrder` fields so no new store keys are needed:
 * - preparing: a quote is being prepared (`reviewing`)
 * - confirming: placement was sent and is being confirmed (`placing`)
 * - still-checking: an interrupted placement is being reconciled (`checking`/`uncertain` with pending)
 * - confirmed: an authoritative order is in hand (`lastOrder` with no pending)
 * - rejected: the last placement was definitively rejected (`idle` + `checkoutError`)
 * - idle: no checkout in progress
 */
export type CheckoutStatus = 'preparing' | 'confirming' | 'still-checking' | 'confirmed' | 'rejected' | 'idle';

export function deriveCheckoutStatus(input: {
  phase: CheckoutPhase;
  pending: unknown;
  checkoutError: string | null;
  lastOrder: { orderId: string } | null;
}): CheckoutStatus {
  if (input.phase === 'reviewing') return 'preparing';
  if (input.phase === 'placing') return 'confirming';
  if (input.phase === 'checking' || input.phase === 'uncertain') return 'still-checking';
  if (input.pending) return 'still-checking';
  if (input.lastOrder) return 'confirmed';
  if (input.checkoutError) return 'rejected';
  return 'idle';
}

/** True while cart/address/coupon writes must pause; browsing and history stay usable. */
export function isCheckoutLocked(phase: CheckoutPhase, pending: unknown): boolean {
  return Boolean(pending) || phase === 'placing' || phase === 'checking' || phase === 'uncertain';
}

function statusLabel(value: string): string {
  return value.replaceAll('_', ' ').toLowerCase();
}

/** Authoritative title shown as soon as `lastOrder` is available. */
export function placementOrderTitle(order: { orderNumber?: string; orderId: string }): string {
  return `Order ${order.orderNumber ?? order.orderId}`;
}

/**
 * Real order/payment copy for replayed placements. Progressed and cancelled
 * orders keep their server status instead of a generic "confirmed" label.
 */
export function describePlacementOrder(order: { status: string; paymentStatus: string }): { title: string; detail: string } {
  const normalized = order.status.toUpperCase();
  const payment = statusLabel(order.paymentStatus);
  if (normalized === 'CANCELLED') {
    return { title: 'Order cancelled', detail: `This order was cancelled. Payment: ${payment}.` };
  }
  if (['DELIVERED', 'OUT_FOR_DELIVERY', 'PACKED', 'PICKING', 'CONFIRMED', 'PENDING_PAYMENT'].includes(normalized)) {
    return { title: statusLabel(order.status), detail: `Payment: ${payment}. You can follow its progress in My Dairy.` };
  }
  if (['FAILED', 'RETURNED', 'EXPIRED'].includes(normalized)) {
    return { title: statusLabel(order.status), detail: `This order did not complete. Payment: ${payment}.` };
  }
  return { title: statusLabel(order.status), detail: `Payment: ${payment}.` };
}

/** Only errors that prove the placement was rejected may release its saved key. */
export function isDefinitivePlacementError(error: unknown): boolean {
  return error instanceof ApiError && [
    'COD_NOT_ELIGIBLE', 'COD_LIMIT_EXCEEDED', 'PRICE_CHANGED', 'QUOTE_EXPIRED',
    'QUOTE_CONSUMED', 'CART_INTENT_CONSUMED',
    'CONCURRENT_MODIFICATION', 'INVENTORY_INSUFFICIENT', 'ITEM_UNAVAILABLE',
    'ADDRESS_NOT_SERVICEABLE', 'ADDRESS_LOCATION_REQUIRED', 'CART_NOT_FOUND',
    'WALLET_INSUFFICIENT', 'WALLET_DISABLED', 'COUPON_INVALID',
    'MIN_ORDER_NOT_MET', 'MAX_ORDER_EXCEEDED',
  ].includes(error.code);
}

export function recoveryDelay(attempt: number): number {
  return [1000, 2000, 4000, 8000, 15000][Math.min(attempt, 4)];
}
