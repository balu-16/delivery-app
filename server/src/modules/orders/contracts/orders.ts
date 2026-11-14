import type { TransactionContext } from '../../../platform/database/database.js';

/**
 * Public contracts of the orders module (P6.3/P6.4). Checkout drives
 * `create`/`confirm` inside its placement transaction; the payments webhook
 * consumer and cancellation/refund flows drive the compensation routine.
 * Cross-module callers import only this file. Lock ordering: the order row is
 * locked first, then attempt/refund rows, capacity, coupon quota, wallet and
 * sorted stock rows (plan 5.1).
 */
export const ORDERS = Symbol('ORDERS');
export const ORDER_INTEGRATION = Symbol('ORDER_INTEGRATION');
export const ORDER_PICKING_INTEGRATION = Symbol('ORDER_PICKING_INTEGRATION');
/** Outbox consumer name for payment funding events (see payments.funding.*). */
export const ORDERS_CONSUMER = 'orders';

export type OrderStatus =
  | 'PENDING_PAYMENT'
  | 'CONFIRMED'
  | 'PICKING'
  | 'PACKED'
  | 'OUT_FOR_DELIVERY'
  | 'DELIVERED'
  | 'PAYMENT_FAILED'
  | 'EXPIRED'
  | 'CANCELLED'
  | 'DELIVERY_FAILED'
  | 'RETURNED_TO_STORE';
export type PaymentStatus =
  'UNPAID' | 'PAID' | 'PARTIALLY_REFUNDED' | 'REFUNDED' | 'COD_PENDING' | 'COD_COLLECTED';
export type PaymentMethod = 'GATEWAY' | 'WALLET' | 'COD' | 'ZERO_DUE';

export interface OrderItemInput {
  variantId: string;
  nameSnapshot: string;
  hsnCode: string;
  orderedQty: string;
  unitPricePaise: string;
  mrpPaise: string;
  discountPaise: string;
  taxPaise: string;
  taxRateBps: number;
}
export interface OrderFeeLine {
  kind: 'DELIVERY' | 'HANDLING' | 'SMALL_CART' | 'SURGE' | 'TIP';
  amountPaise: string;
  taxPaise: string;
  taxSplit: 'CGST_SGST' | 'IGST' | null;
}
export interface CreateOrderInput {
  readonly orderId: string;
  /**
   * Optional: the aggregate assigns a unique human order number when omitted
   * so every placement path (checkout, subscriptions, admin repairs) shares
   * one generator.
   */
  readonly orderNumber?: string;
  readonly userId: string;
  readonly storeId: string;
  readonly addressSnapshot: JsonRecord;
  readonly items: readonly OrderItemInput[];
  readonly fees: readonly OrderFeeLine[];
  readonly subtotalPaise: string;
  readonly discountPaise: string;
  readonly feeTotalPaise: string;
  readonly taxTotalPaise: string;
  readonly tipPaise: string;
  readonly totalPaise: string;
  readonly walletPromoPaise: string;
  readonly walletCashPaise: string;
  readonly amountDuePaise: string;
  readonly deliverySlot: JsonRecord | null;
  readonly source?: 'CUSTOMER' | 'SUBSCRIPTION';
  /** Coupon reservation id and placement correlations (frozen at placement). */
  readonly metadata: JsonRecord;
  readonly expiresAt: string | null;
  readonly tx: TransactionContext;
}
export type JsonRecord = Record<string, unknown>;

export interface OrderItemView {
  id: string;
  variantId: string;
  name: string;
  orderedQty: string;
  fulfilledQty: string;
  shortQty: string;
  unitPricePaise: string;
  taxPaise: string;
  lineStatus: string;
}
export interface OrderView {
  orderId: string;
  orderNumber: string;
  userId: string;
  storeId: string;
  status: OrderStatus;
  onHold: boolean;
  paymentStatus: PaymentStatus;
  paymentMethod: PaymentMethod | null;
  subtotalPaise: string;
  discountPaise: string;
  feeTotalPaise: string;
  taxTotalPaise: string;
  tipPaise: string;
  totalPaise: string;
  walletPromoPaise: string;
  walletCashPaise: string;
  amountDuePaise: string;
  currency: string;
  placedAt: string;
  expiresAt: string | null;
  confirmedAt: string | null;
  deliveredAt: string | null;
  cancelReason: string | null;
  items: readonly OrderItemView[];
  fees: readonly OrderFeeLine[];
  metadata: JsonRecord;
  version: string;
}

export type ActorType = 'CUSTOMER' | 'ADMIN' | 'SYSTEM' | 'RIDER' | 'PICKER' | 'STORE_MANAGER';
export interface Actor {
  readonly type: ActorType;
  readonly id: string | null;
}
export interface TimelineEntry {
  previousState: string | null;
  state: string;
  action: string;
  actorType: string;
  actorId: string | null;
  reason: string | null;
  at: string;
}

export interface OrderListPage {
  items: readonly OrderView[];
  nextCursor: string | null;
}
export interface AdminOrderFilter {
  readonly status?: OrderStatus;
  readonly storeId?: string;
  readonly userId?: string;
  readonly placedAfter?: string;
}

export type FundingKind = 'GATEWAY' | 'COD' | 'ZERO_DUE' | 'WALLET';
export interface ConfirmationInput {
  readonly kind: FundingKind;
  /** Gateway attempt id when funded by a captured payment. */
  readonly attemptId?: string;
  readonly gatewayPaymentId?: string | null;
}

/**
 * The one shared compensation routine (plan 20.3/21): reverse wallet
 * allocation once, release only outstanding stock/coupon obligations and
 * reserve external refunds before initiating; every effect is idempotent.
 */
export interface OrderCompensation {
  compensate(
    orderId: string,
    input: { reason: string; actor: Actor; refundCaptured: boolean },
    tx?: TransactionContext,
  ): Promise<void>;
}
export interface OrderOperations {
  /** Inserts the frozen order + items + history inside the caller's transaction. */
  create(input: CreateOrderInput): Promise<OrderView>;
  byId(
    orderId: string,
    opts?: { userId?: string; tx?: TransactionContext },
  ): Promise<OrderView | null>;
  /** Status transition under FOR UPDATE with the state-machine guard + history. */
  transition(
    orderId: string,
    expectedStatus: OrderStatus,
    next: OrderStatus,
    action: string,
    actor: Actor,
    opts?: { reason?: string; tx?: TransactionContext; metadata?: JsonRecord },
  ): Promise<OrderView>;
  confirm(orderId: string, input: ConfirmationInput, tx: TransactionContext): Promise<OrderView>;
  cancel(
    orderId: string,
    actor: Actor,
    reason: string,
    opts?: { tx?: TransactionContext },
  ): Promise<OrderView>;
  /** Reinstates ONLY system-expired orders when the flag allows (P6.4). */
  reinstate(orderId: string, actor: Actor): Promise<OrderView>;
  expireDue(limit: number): Promise<number>;
  timeline(orderId: string, opts?: { userId?: string }): Promise<readonly TimelineEntry[]>;
  list(userId: string, limit: number, cursor?: string): Promise<OrderListPage>;
  adminList(filter: AdminOrderFilter, limit: number, cursor?: string): Promise<OrderListPage>;
  /** Same-zone, fee-preserving, pre-PICKING address change (GEO-03). */
  changeAddress(
    orderId: string,
    userId: string,
    input: { addressId: string; addressSnapshot: JsonRecord },
  ): Promise<OrderView>;
  /** Builds a NEW cart from previous items at current prices; never places an order. */
  reorder(
    orderId: string,
    userId: string,
    opts?: { tx?: TransactionContext },
  ): Promise<ReorderResult>;
  /** Forces a guarded repair transition (SUPER_ADMIN maker-checker, D25). */
  forceState(
    orderId: string,
    next: OrderStatus,
    reason: string,
    adminId: string,
  ): Promise<OrderView>;
}
export interface ReorderLine {
  variantId: string;
  quantity: string;
}
export interface ReorderResult {
  cartId: string;
  added: readonly ReorderLine[];
  issues: readonly { variantId: string; code: string }[];
}
/** Delivery code attempts (D20/ADD-15): persisted, bounded, lockable. */
export const ORDER_CODES = Symbol('ORDER_CODES');
export interface OrderCodes {
  issue(orderId: string, tx?: TransactionContext): Promise<void>;
  present(orderId: string, userId: string): Promise<{ code: string; keyVersion: number }>;
  verify(orderId: string, code: string, tx?: TransactionContext): Promise<boolean>;
  resetLock(orderId: string, adminId: string, reason: string): Promise<void>;
}
