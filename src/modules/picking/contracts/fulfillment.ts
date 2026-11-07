import type { TransactionContext } from '../../../platform/database/database.js';

/**
 * Consumer-side integration ports. P6 (orders/payments) binds real
 * implementations; until then the picking module boots with typed
 * FULFILLMENT_DEPENDENCY_UNAVAILABLE providers and tests use fakes.
 * The exact signatures below are the recorded P6 dependency assumptions
 * (ADR 0010); integration adapters reconcile naming differences.
 */

/** Expected shape of the `ORDER_CONFIRMED` outbox event payload (producer: P6 orders). */
export interface OrderConfirmedPayload {
  orderId: string;
  orderNumber: string;
  userId: string;
  storeId: string;
  /** Delivery target used for batch shelf-life eligibility. */
  targetDeliveryAt: string;
  items: {
    orderItemId: string;
    variantId: string;
    name: string;
    quantity: string;
  }[];
}

export interface StoreOrderSummary {
  orderId: string;
  orderNumber: string | null;
  status: string;
  itemCount: number;
  placedAt: string | null;
  /** Current picking context when a task exists. */
  pickTaskId: string | null;
  pickTaskStatus: string | null;
}

export const ORDER_FULFILLMENT = Symbol('ORDER_FULFILLMENT');
export interface OrderFulfillment {
  /** Order CONFIRMED → PICKING when a picker starts the task. */
  startPicking(orderId: string, actorId: string, tx?: TransactionContext): Promise<void>;
  /** Order PICKING → PACKED after packing is recorded. */
  markPacked(orderId: string, actorId: string, tx?: TransactionContext): Promise<void>;
}

export interface ShortAdjustmentLine {
  orderItemId: string;
  shortQty: string;
  reason: string;
  substituteVariantId?: string;
}
export interface AdjustmentSummary {
  refundedPaise: string;
  creditNoteRequired: boolean;
}
export const FINANCIAL_ADJUSTMENTS = Symbol('FINANCIAL_ADJUSTMENTS');
export interface FinancialAdjustments {
  /** Recomputes order totals from fulfilled quantities and triggers the refund once. */
  recordShort(input: {
    orderId: string;
    actorId: string;
    lines: ShortAdjustmentLine[];
    tx?: TransactionContext;
  }): Promise<AdjustmentSummary>;
}

export const ORDER_CANCELLATION = Symbol('ORDER_CANCELLATION');
export interface OrderCancellation {
  /** Shared cancel routine: releases obligations and compensates exactly once. */
  systemCancel(orderId: string, reason: string, tx?: TransactionContext): Promise<void>;
}

export const ORDER_FULFILLMENT_READS = Symbol('ORDER_FULFILLMENT_READS');
export interface OrderFulfillmentReads {
  storeOrders(
    storeId: string,
    cursor?: string,
    limit?: number,
  ): Promise<{ items: StoreOrderSummary[]; nextCursor: string | null }>;
  orderSummary(orderId: string): Promise<StoreOrderSummary | null>;
}
