import type { TransactionContext } from '../../../platform/database/database.js';

/**
 * Consumer-side integration ports (ADR 0011). P6 (orders) binds real
 * implementations; until then dispatch boots with typed fail-closed stand-ins
 * that throw DISPATCH_DEPENDENCY_UNAVAILABLE inside the caller's transaction,
 * so custody and money can never diverge. The signatures below are the
 * recorded P6 dependency assumptions; integration adapters absorb differences.
 */

export const DISPATCH_DEPENDENCY_UNAVAILABLE = 'DISPATCH_DEPENDENCY_UNAVAILABLE';

export interface DeliveryAddressSnapshot {
  line1?: string;
  line2?: string;
  landmark?: string;
  pincode?: string;
  contactName?: string;
  contactPhone?: string;
  lat?: number;
  lng?: number;
}

export interface OrderDeliverySummary {
  orderId: string;
  orderNumber: string;
  userId: string;
  storeId: string;
  status: string;
  paymentMethod: 'GATEWAY' | 'WALLET' | 'COD' | 'ZERO_DUE' | null;
  amountDuePaise: string;
  tipPaise: string;
  addressSnapshot: DeliveryAddressSnapshot | null;
}

export const ORDER_DELIVERY_READS = Symbol('ORDER_DELIVERY_READS');
export interface OrderDeliveryReads {
  orderSummary(orderId: string): Promise<OrderDeliverySummary | null>;
}

export const ORDER_DELIVERY = Symbol('ORDER_DELIVERY');
export interface OrderDelivery {
  markReturnedToStore(
    orderId: string,
    actorId: string,
    reason: string,
    tx?: TransactionContext,
  ): Promise<void>;
  markPickedUp(orderId: string, actorId: string, tx?: TransactionContext): Promise<void>;
  /** Order …→ OUT_FOR_DELIVERY → DELIVERED with the delivered timestamp. */
  markDelivered(orderId: string, actorId: string, tx?: TransactionContext): Promise<void>;
  /** Order → DELIVERY_FAILED with a required reason and evidence. */
  markDeliveryFailed(
    orderId: string,
    actorId: string,
    reason: string,
    evidence: Record<string, string> | undefined,
    tx?: TransactionContext,
    actorType?: 'RIDER' | 'ADMIN',
  ): Promise<void>;
}

export const ORDER_SYSTEM_CANCEL = Symbol('ORDER_SYSTEM_CANCEL');
export interface OrderSystemCancel {
  /** Shared cancel routine (releases stock/coupon/wallet, refunds). */
  systemCancel(orderId: string, reason: string, tx?: TransactionContext): Promise<void>;
}
