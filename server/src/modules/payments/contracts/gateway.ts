/**
 * Payment gateway port (ADR 0007). Implementations: fake (deterministic, local/test)
 * and Razorpay over built-in fetch. No vendor SDK.
 *
 * Razorpay API surface cited from https://razorpay.com/docs/api/orders/,
 * https://razorpay.com/docs/api/refunds/ and https://razorpay.com/docs/api/payments/
 * (retrieved 2026-11-06). Refund idempotency uses the documented
 * `X-Refund-Idempotency` header
 * (https://razorpay.com/docs/api/refunds/normal-refunds-idempotent/, retrieved 2026-11-06).
 * ADR 0007: `receipt` is echoed, not an idempotency guarantee, so lost create
 * responses recover through the documented lookup path instead of a second create.
 */
export interface CreateOrderInput {
  /** Stable durable-operation reference persisted before the call. */
  readonly operationReference: string;
  /** Integer paise as a canonical decimal string. */
  readonly amountPaise: string;
  readonly currency: string;
  /** Merchant reference echoed by the gateway; not an idempotency key. */
  readonly receipt?: string;
}
export interface GatewayOrder {
  readonly gatewayOrderId: string | null;
  readonly status: 'CREATED' | 'UNKNOWN';
}
export type GatewayPaymentStatus =
  'CREATED' | 'AUTHORIZED' | 'CAPTURED' | 'FAILED' | 'REFUNDED' | 'PARTIALLY_REFUNDED';
export interface GatewayPayment {
  readonly gatewayPaymentId: string;
  readonly gatewayOrderId: string;
  readonly amountPaise: string;
  readonly currency: string;
  readonly status: GatewayPaymentStatus;
}
export interface GatewayOrderSummary {
  readonly gatewayOrderId: string;
  readonly amountPaise: string;
  readonly currency: string;
  readonly status: string;
}
export interface RefundInput {
  /** Durable refund operation reference; sent as `X-Refund-Idempotency`. */
  readonly refundReference: string;
  readonly gatewayPaymentId: string;
  readonly amountPaise: string;
}
export type GatewayRefundStatus = 'PROCESSED' | 'PENDING' | 'FAILED' | 'UNKNOWN';
export interface GatewayRefund {
  readonly gatewayRefundId: string | null;
  readonly status: GatewayRefundStatus;
}
export interface GatewaySettlement {
  readonly gatewaySettlementId: string;
  readonly amountPaise: string;
  readonly currency: string;
  readonly occurredAt: string;
}
export interface FetchPaymentInput {
  readonly gatewayPaymentId?: string;
  readonly gatewayOrderId?: string;
}
export interface SettlementPage {
  readonly items: readonly GatewaySettlement[];
  readonly nextCursor: string | null;
}
export interface PaymentGatewayPort {
  createOrder(input: CreateOrderInput): Promise<GatewayOrder>;
  /** Null means the gateway definitively has no such payment; ambiguity throws. */
  fetchPayment(input: FetchPaymentInput): Promise<GatewayPayment | null>;
  /** Documented recovery path for a lost create response: filter the order list. */
  findOrdersByReceipt(receipt: string): Promise<readonly GatewayOrderSummary[]>;
  /** All payments made toward one gateway order (duplicate capture detection). */
  listOrderPayments(gatewayOrderId: string): Promise<readonly GatewayPayment[]>;
  refund(input: RefundInput): Promise<GatewayRefund>;
  fetchRefund(gatewayRefundId: string): Promise<GatewayRefund>;
  /**
   * Documented recovery path for a lost refund response: list the payment's
   * refunds and match the durable reference carried in the refund `receipt`.
   * Null means the provider definitively has no such refund; ambiguity throws.
   */
  findRefundByReceipt(gatewayPaymentId: string, receipt: string): Promise<GatewayRefund | null>;
  verifyCheckoutSignature(input: {
    readonly gatewayOrderId: string;
    readonly gatewayPaymentId: string;
    readonly signature: string;
  }): boolean;
  /** HMAC over the exact raw request bytes with the webhook secret (timing safe). */
  verifyWebhook(rawBody: Uint8Array, signature: string, secret: string): boolean;
  fetchSettlements(input: {
    readonly from?: string;
    readonly to?: string;
    readonly limit: number;
  }): Promise<SettlementPage>;
}
export const PAYMENT_GATEWAY = Symbol('PAYMENT_GATEWAY');

/** Transport-level failure where retrying is safe and the outcome is unknown. */
export class GatewayUnavailableError extends Error {
  readonly code = 'ExternalServiceUnavailable';
}
export class GatewayTimeoutError extends Error {
  readonly code = 'ExternalServiceTimeout';
}
/** Definitive provider-side rejection; retrying without change cannot succeed. */
export class GatewayRejectedError extends Error {
  readonly code = 'ExternalServiceRejected';
  constructor(
    readonly providerStatus: number,
    message?: string,
  ) {
    super(message ?? 'ExternalServiceRejected');
  }
}
/** The outcome happened but could not be read back reliably. */
export class GatewayAmbiguousError extends Error {
  readonly code = 'GATEWAY_OUTCOME_UNKNOWN';
}
export function isGatewayAmbiguous(error: unknown): boolean {
  return error instanceof GatewayAmbiguousError || error instanceof GatewayTimeoutError;
}
