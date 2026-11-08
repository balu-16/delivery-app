import type { TransactionContext } from '../../../platform/database/database.js';
import type { QuoteSnapshot } from '../../cart/contracts/quote.js';
import type { OrderView } from '../../orders/contracts/orders.js';

/**
 * Public contracts of the checkout module (P6.3). Surfaces call
 * `quote` (CART_QUOTES.refresh + CART_INTENTS.issue) and `place` (the single
 * placement saga consuming the intent). Cross-module callers import only this
 * file. Placement lock order inside the one transaction: cart intent -> quote
 * snapshot -> coupon quota -> wallet account -> sorted stock rows -> order
 * insert. Capacity admission joins the same placement transaction.
 */
export const CHECKOUT = Symbol('CHECKOUT');

export interface CheckoutQuoteRequest {
  readonly addressId: string;
  readonly tipPaise?: string;
  readonly couponCode?: string | null;
}

export interface CheckoutQuoteResult {
  readonly quote: QuoteSnapshot;
  readonly intentId: string;
  /** The intent expires with the quote snapshot (payment window). */
  readonly intentExpiresAt: string;
}

export type PreferredMethod = 'GATEWAY' | 'COD';

export interface CheckoutPlaceRequest {
  readonly quoteId: string;
  readonly intentId: string;
  /** Customer preference when the quote leaves an amount due. */
  readonly method: PreferredMethod;
  /**
   * The HTTP idempotency operation id claimed by the surface. A crash between
   * placement commit and gateway setup resumes THIS order on retry instead of
   * placing again (plan 5.2).
   */
  readonly idempotencyOperationId: string;
}

export interface CheckoutPaymentView {
  readonly attemptId: string;
  readonly operationReference: string;
  readonly gatewayOrderId: string | null;
  readonly amountDuePaise: string;
  readonly currency: string;
  readonly provider: 'fake' | 'razorpay';
  /** Public checkout key for Razorpay; null for the fake provider. */
  readonly publicKeyId: string | null;
}

export interface CheckoutPlaceResult {
  readonly order: OrderView;
  /** Null for zero-due and COD confirmations (no gateway call, ever). */
  readonly payment: CheckoutPaymentView | null;
  readonly confirmation: 'CONFIRMED' | 'PENDING_PAYMENT';
}

export interface ScheduledOrderInput {
  userId: string;
  subscriptionId: string;
  deliveryDate: string;
  storeId: string;
  addressId: string;
  variantId: string;
  quantity: string;
  slotStart: string;
  slotEnd: string;
}

export interface CheckoutOperations {
  /** Current scheduled price estimate, without creating a cart or financial obligations. */
  priceScheduled(
    input: ScheduledOrderInput,
    tx: TransactionContext,
  ): Promise<{ unitPricePaise: string; totalPaise: string }>;
  /** Caller owns the transaction and has locked the subscription occurrence. */
  placeScheduled(
    input: ScheduledOrderInput,
    tx: TransactionContext,
  ): Promise<{ orderId: string; unitPricePaise: string; totalPaise: string }>;
  /** Re-prices the cart, persists the expiring snapshot and issues the intent. */
  quote(userId: string, input: CheckoutQuoteRequest): Promise<CheckoutQuoteResult>;
  /**
   * Consumes the cart intent and places the order in ONE transaction:
   * capacity/coupon/stock/wallet obligations, frozen order + history +
   * ORDER_CREATED outbox, then gateway setup strictly after the commit.
   */
  place(userId: string, input: CheckoutPlaceRequest): Promise<CheckoutPlaceResult>;
  /** Durable gateway create for an attempt created inside the placement tx. */
  completePaymentSetup(
    operationReference: string,
    receipt: string,
  ): Promise<CheckoutPaymentView | null>;
}

/**
 * COD decision inputs (plan 20.1). The store accepts COD, the amount is
 * within the configured cap and the account has the configured number of
 * completed prepaid orders. Never for subscriptions (source is frozen at
 * CUSTOMER here; P10 reuses the policy with its own guard).
 */
export interface CodPolicyInput {
  readonly codEnabled: boolean;
  readonly storeAcceptsCod: boolean;
  readonly amountDuePaise: string;
  readonly maxCodPaise: string;
  readonly completedPrepaidOrders: number;
  readonly minCompletedPrepaidOrders: number;
}

export type CodVerdict =
  { allowed: true } | { allowed: false; code: 'COD_NOT_ELIGIBLE' | 'COD_LIMIT_EXCEEDED' };

/** Pure COD decision so the eligibility matrix stays unit-tested. */
export function evaluateCod(input: CodPolicyInput): CodVerdict {
  if (!input.codEnabled || !input.storeAcceptsCod)
    return { allowed: false, code: 'COD_NOT_ELIGIBLE' };
  if (BigInt(input.amountDuePaise) > BigInt(input.maxCodPaise))
    return { allowed: false, code: 'COD_LIMIT_EXCEEDED' };
  if (input.completedPrepaidOrders < input.minCompletedPrepaidOrders)
    return { allowed: false, code: 'COD_NOT_ELIGIBLE' };
  return { allowed: true };
}

export type { TransactionContext };
