import type { OrderStatus } from '../contracts/orders.js';

/**
 * Order lifecycle (Section 11): transitions are guarded; every legal edge is
 * listed. Cancellation is a transition to CANCELLED validated separately by
 * the actor matrix in cancellation-policy.ts.
 */
const TRANSITIONS: Readonly<Record<OrderStatus, readonly OrderStatus[]>> = {
  PENDING_PAYMENT: ['CONFIRMED', 'PAYMENT_FAILED', 'EXPIRED', 'CANCELLED'],
  CONFIRMED: ['PICKING', 'CANCELLED'],
  PICKING: ['PACKED', 'CANCELLED'],
  PACKED: ['OUT_FOR_DELIVERY', 'CANCELLED'],
  OUT_FOR_DELIVERY: ['DELIVERED', 'DELIVERY_FAILED'],
  DELIVERED: ['RETURNED_TO_STORE'],
  PAYMENT_FAILED: ['EXPIRED', 'CANCELLED'],
  EXPIRED: [],
  CANCELLED: [],
  DELIVERY_FAILED: ['RETURNED_TO_STORE', 'OUT_FOR_DELIVERY'],
  RETURNED_TO_STORE: [],
};

export function transitionOrderStatus(current: OrderStatus, next: OrderStatus): OrderStatus {
  if (!TRANSITIONS[current]?.includes(next)) throw new Error('ILLEGAL_STATE_TRANSITION');
  return next;
}

/** Customer-visible friendly mapping (Section 21); internal-only states hidden. */
const FRIENDLY: Readonly<Record<OrderStatus, string>> = {
  PENDING_PAYMENT: 'Paying',
  CONFIRMED: 'Confirmed',
  PICKING: 'Packing',
  PACKED: 'Packed',
  OUT_FOR_DELIVERY: 'On the way',
  DELIVERED: 'Delivered',
  PAYMENT_FAILED: 'Payment issue',
  EXPIRED: 'Expired',
  CANCELLED: 'Cancelled',
  DELIVERY_FAILED: 'Delivery issue',
  RETURNED_TO_STORE: 'Returned',
};
export function friendlyStatus(status: OrderStatus): string {
  return FRIENDLY[status];
}
/** Timeline states never shown to customers (internal-only transitions). */
export const INTERNAL_ONLY_STATES: ReadonlySet<string> = new Set([
  'PAYMENT_FAILED',
  'RETURNED_TO_STORE',
]);

/** Force-state is a guarded REPAIR channel (D25), not an arbitrary write. */
export const FORCE_STATE_ALLOWED: Readonly<Record<OrderStatus, readonly OrderStatus[]>> = {
  PENDING_PAYMENT: ['EXPIRED', 'CANCELLED'],
  CONFIRMED: ['CANCELLED'],
  PICKING: ['CANCELLED'],
  PACKED: ['CANCELLED'],
  OUT_FOR_DELIVERY: ['DELIVERY_FAILED'],
  DELIVERED: [],
  PAYMENT_FAILED: ['EXPIRED'],
  EXPIRED: [],
  CANCELLED: [],
  DELIVERY_FAILED: ['RETURNED_TO_STORE'],
  RETURNED_TO_STORE: [],
};
