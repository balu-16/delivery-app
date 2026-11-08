import type { TransactionContext } from '../../../platform/database/database.js';

/**
 * Public dispatch contracts (P8): rider-facing delivery tasks and offers,
 * the shared cancellation routine for P6, and the D20 delivery-code port
 * over 007's order_code_verifiers. Cross-module callers may import only
 * contracts; order state transitions flow through the ports in
 * contracts/dependencies.ts, bound to the order aggregate.
 */

export type DeliveryTaskStatus =
  | 'UNASSIGNED'
  | 'OFFERED'
  | 'ASSIGNED'
  | 'AT_STORE'
  | 'PICKED_UP'
  | 'ARRIVED'
  | 'DELIVERED'
  | 'FAILED'
  | 'CANCELLED';

/** Custody states where exactly one rider holds the delivery. */
export const CUSTODY_STATUSES: readonly DeliveryTaskStatus[] = [
  'ASSIGNED',
  'AT_STORE',
  'PICKED_UP',
  'ARRIVED',
];

export interface DeliveryTaskView {
  id: string;
  orderId: string;
  storeId: string;
  status: DeliveryTaskStatus;
  riderId: string | null;
  attemptNo: number;
  pickupAt: string | null;
  arrivedStoreAt: string | null;
  arrivedCustomerAt: string | null;
  deliveredAt: string | null;
  etaMinMinutes: number | null;
  etaMaxMinutes: number | null;
  /** Present for COD orders; the rider collects this amount. */
  codAmountPaise: string | null;
  /** Shown to the assigned rider before pickup (store verifies via P7). */
  handoverCode: string | null;
  version: string;
}

export interface OfferView {
  offerId: string;
  taskId: string;
  orderId: string;
  storeId: string;
  attemptNo: number;
  expiresAt: string;
  codAmountPaise: string | null;
}

export interface OfferPage {
  items: OfferView[];
}

export interface DeliverInput {
  /** Customer-shown 4-digit code (attempt-limited verification). */
  deliveryCode?: string;
  /** Contactless proof-of-delivery media id (requires POD upload). */
  podMediaId?: string;
}

export interface FailInput {
  reason: string;
  evidence?: Record<string, string>;
}

export interface ContactView {
  contactName: string;
  contactPhone: string;
}

export const DELIVERY_TASKS = Symbol('DELIVERY_TASKS');
export const DELIVERY_ASSIGNMENT = Symbol('DELIVERY_ASSIGNMENT');
export const WRONG_ADDRESS = Symbol('WRONG_ADDRESS');
export interface WrongAddress {
  flag(
    riderId: string,
    taskId: string,
    reason: string,
    reference: string,
  ): Promise<{ flagId: string }>;
  resolve(
    adminId: string,
    orderId: string,
    reason: string,
    reference: string,
  ): Promise<{ flagId: string; status: 'FAILED' }>;
}
export interface DeliveryAssignment {
  assign(
    orderId: string,
    riderId: string,
    actorId: string,
    reason: string,
    reference: string,
  ): Promise<DeliveryTaskView>;
}
export interface DeliveryTasks {
  /** Open, unexpired offers for the rider (poll fallback for the socket). */
  offers(riderId: string): Promise<OfferPage>;
  /** Atomic assignment under order/task/rider locks; exactly one winner. */
  accept(riderId: string, offerId: string, reference: string): Promise<DeliveryTaskView>;
  decline(riderId: string, offerId: string, reference: string): Promise<{ state: 'DECLINED' }>;
  /** Session restore after app crash/reinstall (DSP-02). */
  currentTask(riderId: string): Promise<DeliveryTaskView | null>;
  arrivedAtStore(
    riderId: string,
    taskId: string,
    reference: string,
    point?: { lat: number; lng: number },
  ): Promise<DeliveryTaskView>;
  /** Requires the verified P7 handover; takes custody of the parcel. */
  pickedUp(riderId: string, taskId: string, reference: string): Promise<DeliveryTaskView>;
  arrived(
    riderId: string,
    taskId: string,
    reference: string,
    point?: { lat: number; lng: number },
  ): Promise<DeliveryTaskView>;
  /**
   * Completes delivery: verifies the code (or accepts POD), blocks mismatched
   * COD, settles the order through the P6 port and records earnings once.
   */
  deliver(
    riderId: string,
    taskId: string,
    input: DeliverInput,
    reference: string,
  ): Promise<DeliveryTaskView>;
  /**
   * Pre-pickup the task re-dispatches (attempt_no+1); post-pickup it ends
   * FAILED through the P6 port with the reason and evidence retained.
   */
  fail(
    riderId: string,
    taskId: string,
    input: FailInput,
    reference: string,
  ): Promise<DeliveryTaskView>;
  /** Customer contact is visible only during the custody window (GEO-04). */
  contact(riderId: string, taskId: string): Promise<ContactView | null>;
  recordContactAttempt(
    riderId: string,
    taskId: string,
    reference: string,
  ): Promise<{ recordedAt: string }>;
  /**
   * Records collected COD cash for the rider's task; a mismatch with the
   * frozen amount due is flagged and blocks automatic completion (PAY-09).
   */
  codCollect(
    riderId: string,
    taskId: string,
    input: { amountPaise: string },
    reference: string,
  ): Promise<{
    orderId: string;
    collectedPaise: string;
    expectedPaise: string | null;
    mismatch: boolean;
  }>;
}

/** Compensating cancel used by P6's shared cancellation routine (ADR 0011). */
export const DELIVERY_TASK_CANCELLATION = Symbol('DELIVERY_TASK_CANCELLATION');
export interface DeliveryTaskCancellation {
  /** Cancels the active task, revokes offers, releases rider capacity. */
  cancel(orderId: string, reason: string, tx?: TransactionContext): Promise<void>;
}

export const DELIVERY_CODES = Symbol('DELIVERY_CODES');
export interface DeliveryCodes {
  /** Persists only the HMAC verifier + key version (idempotent per order). */
  issue(orderId: string, tx?: TransactionContext): Promise<{ state: 'PENDING' }>;
  /** Authorized read: the assigned rider or the order's customer (D20). */
  present(
    orderId: string,
    requesterId: string,
    role: 'RIDER' | 'CUSTOMER',
  ): Promise<{ code: string; keyVersion: number }>;
  /** Attempt-limited constant-time verification with durable lockout. */
  verify(orderId: string, code: string, actorId: string): Promise<{ state: 'VERIFIED' }>;
}

export interface RiderLocationSnapshot {
  lat: number;
  lng: number;
  at: string;
}
export interface EtaRangeView {
  minMinutes: number;
  maxMinutes: number;
}
export interface OrderTrackingView {
  orderId: string;
  taskStatus: DeliveryTaskStatus;
  attemptNo: number;
  riderLocation: RiderLocationSnapshot | null;
  eta: EtaRangeView | null;
}

/** Customer tracking reads (poll fallback for the /customer namespace). */
export const CUSTOMER_TRACKING = Symbol('CUSTOMER_TRACKING');
export interface CustomerTracking {
  /** Ownership-checked snapshot; null when the order is not the customer's. */
  tracking(orderId: string, customerId: string): Promise<OrderTrackingView | null>;
  /** D20 authorized retrieval of the delivery code (owner only). */
  deliveryCode(orderId: string, customerId: string): Promise<{ code: string; keyVersion: number }>;
}

export const DELIVERY_POD = Symbol('DELIVERY_POD');
export interface DeliveryPod {
  target(
    riderId: string,
    taskId: string,
    contentType: string,
    size: number,
  ): Promise<{ mediaId: string; url: string; fields: Record<string, string> }>;
  complete(riderId: string, taskId: string, mediaId: string): Promise<void>;
}

export const DELIVERY_RETURN = Symbol('DELIVERY_RETURN');
export interface ReturnItem {
  variantId: string;
  quantity: string;
  expiresAt: string | null;
}
export interface DeliveryReturn {
  receive(
    actorId: string,
    orderId: string,
    reason: string,
    items: ReturnItem[],
    reference: string,
  ): Promise<{ returnIds: string[] }>;
}
