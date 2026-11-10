import type { ActorType, OrderStatus } from '../contracts/orders.js';

/**
 * Cancellation matrix defaults (Section 21): every cell is a policy decision
 * kept pure so the stage x actor rules stay testable and auditable. The
 * defaults follow the documented matrix; admin overrides with a reason may
 * cancel from every pre-terminal operational stage.
 */
export type CancellationVerdict =
  { allowed: true; refund: boolean } | { allowed: false; code: 'ILLEGAL_STATE_TRANSITION' };

const MATRIX: Readonly<
  Record<ActorType, Partial<Record<OrderStatus, { allowed: boolean; refund: boolean }>>>
> = {
  CUSTOMER: {
    PENDING_PAYMENT: { allowed: true, refund: false },
    CONFIRMED: { allowed: true, refund: true },
    PICKING: { allowed: false, refund: false },
    PACKED: { allowed: false, refund: false },
    OUT_FOR_DELIVERY: { allowed: false, refund: false },
  },
  ADMIN: {
    PENDING_PAYMENT: { allowed: true, refund: false },
    CONFIRMED: { allowed: true, refund: true },
    PICKING: { allowed: true, refund: true },
    PACKED: { allowed: true, refund: true },
    OUT_FOR_DELIVERY: { allowed: false, refund: false },
  },
  SYSTEM: {
    PENDING_PAYMENT: { allowed: true, refund: false },
    CONFIRMED: { allowed: true, refund: true },
    PICKING: { allowed: true, refund: true },
    PACKED: { allowed: true, refund: true },
  },
  RIDER: {},
  PICKER: {},
};

export function evaluateCancellation(status: OrderStatus, actor: ActorType): CancellationVerdict {
  const cell = MATRIX[actor]?.[status];
  if (!cell || !cell.allowed) return { allowed: false, code: 'ILLEGAL_STATE_TRANSITION' };
  return { allowed: true, refund: cell.refund };
}

/** Customer-cancelled orders are never reinstated (plan 6.4). */
export function reinstatable(status: OrderStatus, cancelledByCustomer: boolean): boolean {
  return status === 'EXPIRED' && !cancelledByCustomer;
}
