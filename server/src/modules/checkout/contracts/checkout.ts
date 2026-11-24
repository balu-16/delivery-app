import type { TransactionContext } from '../../../platform/database/database.js';
import type { CartView } from '../../cart/contracts/cart.js';
import type { QuoteSnapshot } from '../../cart/contracts/quote.js';
import type { OrderView } from '../../orders/contracts/orders.js';
import type { IdempotencyOwner } from '../../../common/idempotency/idempotency.js';

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
  /** Advisory only; placement rechecks the same policy inside its transaction. */
  readonly codAvailable: boolean;
  /** Additive cart view from the same evaluation as the quote and intent. */
  readonly cart: CartView;
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
  /** A recovered cancelled, expired or failed order is not awaiting payment. */
  readonly confirmation: 'CONFIRMED' | 'PENDING_PAYMENT' | 'ORDER_CLOSED';
}

/** Status checks never claim a request, place an order, or initiate payment. */
export type CheckoutPlacementStatus =
  | {
      state: 'ORDER_FOUND';
      order: Pick<OrderView, 'orderId' | 'orderNumber' | 'status' | 'paymentStatus'>;
    }
  | { state: 'REJECTED'; code: string }
  | { state: 'PROCESSING' | 'UNKNOWN' };

/**
 * Placement failures that are terminal for the exact request body: retrying
 * the same quote and intent can never succeed (expired/consumed quote, frozen
 * commercial mismatch, unsatisfiable policy). Mirrors the client's
 * isDefinitivePlacementError. The fence additionally resolves same-user
 * intent orders before recording, so cross-key commits recover instead of
 * recording. Everything else (lease loss, timeouts, 5xx, gateway ambiguity,
 * ONLINE_PAYMENTS_NOT_READY, RESOURCE_CONFLICT) stays unknown so the
 * original key keeps retrying safely.
 */
const DEFINITIVE_PLACEMENT_ERRORS = new Set([
  'COD_NOT_ELIGIBLE',
  'COD_LIMIT_EXCEEDED',
  'PRICE_CHANGED',
  'QUOTE_EXPIRED',
  'QUOTE_CONSUMED',
  'CART_INTENT_CONSUMED',
  'CONCURRENT_MODIFICATION',
  'INVENTORY_INSUFFICIENT',
  'ITEM_UNAVAILABLE',
  'ADDRESS_NOT_SERVICEABLE',
  'ADDRESS_LOCATION_REQUIRED',
  'CART_NOT_FOUND',
  'WALLET_INSUFFICIENT',
  'WALLET_DISABLED',
  'COUPON_INVALID',
  'MIN_ORDER_NOT_MET',
  'MAX_ORDER_EXCEEDED',
]);
export function isDefinitivePlacementError(error: unknown): boolean {
  return error instanceof Error && DEFINITIVE_PLACEMENT_ERRORS.has(error.message);
}

/** Internal callers may fence and record an approval in the placement transaction. */
export interface CheckoutPlacementGuard {
  beforePlace(tx: TransactionContext): Promise<void>;
  afterPlace(
    tx: TransactionContext,
    result: { order: OrderView; confirmed: boolean },
  ): Promise<void>;
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
  /** Estimate a bounded group of independent deliveries; unavailable estimates are null. */
  priceScheduledBatch(
    inputs: readonly ScheduledOrderInput[],
  ): Promise<({ unitPricePaise: string; totalPaise: string } | null)[]>;
  /** Caller owns the transaction and has locked the subscription occurrence. */
  placeScheduled(
    input: ScheduledOrderInput,
    tx: TransactionContext,
  ): Promise<{ orderId: string; unitPricePaise: string; totalPaise: string }>;
  /** Re-prices the cart, persists the expiring snapshot and issues the intent. */
  quote(userId: string, input: CheckoutQuoteRequest): Promise<CheckoutQuoteResult>;
  /** A read-only lookup of the authenticated customer's original HTTP request. */
  placementStatus(userId: string, key: string): Promise<CheckoutPlacementStatus>;
  /** Read an already committed order without placing it or initializing payment. */
  recoverCommitted(userId: string, operationId: string): Promise<CheckoutPlaceResult | null>;
  /**
   * Settle a placement whose business transaction failed: recover the
   * committed order when one exists (own operation, or own intent for
   * consumed intents), otherwise record a proven terminal rejection for
   * definitive failures. Returns the recovered result, or null when the
   * caller must rethrow the original error (recorded rejections surface
   * through it and through status checks).
   */
  settleFailedPlacement(
    userId: string,
    owner: IdempotencyOwner,
    input: Pick<CheckoutPlaceRequest, 'intentId'>,
    error: unknown,
  ): Promise<CheckoutPlaceResult | null>;
  /**
   * Consumes the cart intent and places the order in ONE transaction:
   * capacity/coupon/stock/wallet obligations, frozen order + history +
   * ORDER_CREATED outbox, then gateway setup strictly after the commit.
   */
  place(
    userId: string,
    input: CheckoutPlaceRequest,
    owner?: IdempotencyOwner,
    guard?: CheckoutPlacementGuard,
  ): Promise<CheckoutPlaceResult>;
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
