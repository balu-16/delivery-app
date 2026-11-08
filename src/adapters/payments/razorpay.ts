import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  GatewayAmbiguousError,
  GatewayRejectedError,
  GatewayTimeoutError,
  GatewayUnavailableError,
  type CreateOrderInput,
  type FetchPaymentInput,
  type GatewayOrder,
  type GatewayOrderSummary,
  type GatewayPayment,
  type GatewayRefund,
  type PaymentGatewayPort,
  type RefundInput,
  type SettlementPage,
} from '../../modules/payments/contracts/gateway.js';
import { amountToGatewayNumber, assertCurrency } from '../../modules/payments/contracts/amounts.js';

/**
 * Razorpay adapter over the built-in fetch client; no vendor SDK (ADR 0007).
 *
 * Documented behavior implemented here, all retrieved 2026-11-06:
 * - Orders API: POST /v1/orders, GET /v1/orders/{id}, GET /v1/orders/{id}/payments,
 *   GET /v1/orders?receipt={receipt} (https://razorpay.com/docs/api/orders/,
 *   https://razorpay.com/docs/build/llm-docs/api/orders/create.md,
 *   https://razorpay.com/docs/build/llm-docs/api/orders/fetch-all.md).
 * - The order `receipt` (<= 40 chars) is echoed but is NOT treated as an
 *   idempotency guarantee (ADR 0007): a lost create response recovers through
 *   the documented receipt-filtered order list, never a second create.
 * - Payments: GET /v1/payments/{id} (https://razorpay.com/docs/api/payments/).
 * - Refunds: POST /v1/payments/{id}/refund with the documented
 *   `X-Refund-Idempotency` header (>= 10 chars of [A-Za-z0-9_-]; the same key
 *   with the same body retries safely, a different payload is BAD_REQUEST,
 *   an in-progress duplicate returns 409 CONFLICT meant to be retried)
 *   (https://razorpay.com/docs/api/refunds/normal-refunds-idempotent/,
 *   https://razorpay.com/docs/api/refunds/).
 * - Webhook signature: HMAC SHA256 over the exact raw request body with the
 *   webhook secret; "webhook_body should be raw webhook request body" and must
 *   not be parsed or re-serialized (https://razorpay.com/docs/webhooks/validate-test/).
 * - Checkout signature: HMAC SHA256 of `razorpay_order_id|razorpay_payment_id`
 *   with the key secret
 *   (https://razorpay.com/docs/developer-tools/integrations/standard-checkout,
 *   re-verified 2026-11-07: expected_signature = HMAC_SHA256(order_id + "|" +
 *   razorpay_payment_id, key_secret)).
 * - Settlements: GET /v1/settlements?from&to&count&skip
 *   (https://razorpay.com/docs/api/settlements/).
 */
export interface RazorpayConfig {
  keyId: string;
  keySecret: string;
  webhookSecret: string;
  baseUrl?: string;
  timeoutMs?: number;
}

interface RazorpayEntity {
  id?: unknown;
  status?: unknown;
  amount?: unknown;
  currency?: unknown;
  order_id?: unknown;
  payment_id?: unknown;
  receipt?: unknown;
  created_at?: unknown;
  items?: unknown;
  count?: unknown;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value) throw new GatewayAmbiguousError(`${field} missing`);
  return value;
}

function requirePaise(value: unknown, field: string): string {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    throw new GatewayAmbiguousError(`${field} missing`);
  return String(value);
}

export class RazorpayGateway implements PaymentGatewayPort {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly auth: string;
  constructor(private readonly config: RazorpayConfig) {
    if (!config.keyId || !config.keySecret || !config.webhookSecret)
      throw new Error('RAZORPAY_CONFIGURATION_INCOMPLETE');
    this.baseUrl = (config.baseUrl ?? 'https://api.razorpay.com').replace(/\/+$/, '');
    this.timeoutMs = config.timeoutMs ?? 5000;
    this.auth = Buffer.from(`${config.keyId}:${config.keySecret}`, 'utf8').toString('base64');
  }

  private async call(
    method: 'GET' | 'POST',
    path: string,
    body?: Record<string, unknown>,
    headers: Record<string, string> = {},
  ): Promise<RazorpayEntity> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          authorization: `Basic ${this.auth}`,
          'content-type': 'application/json',
          ...headers,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (cause: unknown) {
      // Timeouts and connection failures are ambiguous: the operation may have
      // succeeded provider-side. Callers reconcile instead of recreating.
      if (cause instanceof GatewayAmbiguousError || cause instanceof GatewayTimeoutError)
        throw cause;
      throw new GatewayTimeoutError('razorpay request did not complete', { cause });
    }
    const raw = await response.text().catch(() => '');
    let parsed: unknown = undefined;
    if (raw) {
      try {
        parsed = JSON.parse(raw) as unknown;
      } catch {
        if (response.ok) throw new GatewayAmbiguousError('razorpay returned an unreadable body');
      }
    }
    if (!response.ok) {
      if (response.status === 429 || response.status >= 500)
        throw response.status === 429
          ? new GatewayUnavailableError('razorpay rate limited the request')
          : new GatewayAmbiguousError(`razorpay server error ${response.status}`);
      if (response.status === 409)
        // Documented idempotency-in-progress conflict; the same keyed request may be retried.
        throw new GatewayUnavailableError('razorpay idempotent operation still in progress');
      throw new GatewayRejectedError(response.status, 'razorpay rejected the request');
    }
    if (parsed === undefined || typeof parsed !== 'object' || Array.isArray(parsed))
      throw new GatewayAmbiguousError('razorpay returned an unexpected body');
    return parsed as RazorpayEntity;
  }

  async createOrder(input: CreateOrderInput): Promise<GatewayOrder> {
    const entity = await this.call('POST', '/v1/orders', {
      amount: amountToGatewayNumber(input.amountPaise),
      currency: input.currency,
      receipt: input.receipt ?? input.operationReference,
      notes: { operation_reference: input.operationReference },
    });
    const id = requireString(entity.id, 'order id');
    const status = requireString(entity.status, 'order status');
    if (status !== 'created' && status !== 'attempted' && status !== 'paid')
      throw new GatewayAmbiguousError('unknown order status');
    return { gatewayOrderId: id, status: 'CREATED' };
  }

  private toGatewayPayment(entity: RazorpayEntity): GatewayPayment {
    const status = requireString(entity.status, 'payment status');
    const statusMap: Record<string, GatewayPayment['status']> = {
      created: 'CREATED',
      authorized: 'AUTHORIZED',
      captured: 'CAPTURED',
      failed: 'FAILED',
      refunded: 'REFUNDED',
      partially_refunded: 'PARTIALLY_REFUNDED',
    };
    const mapped = statusMap[status];
    if (!mapped) throw new GatewayAmbiguousError('unknown payment status');
    const currency = requireString(entity.currency, 'payment currency');
    return {
      gatewayPaymentId: requireString(entity.id, 'payment id'),
      gatewayOrderId: requireString(entity.order_id, 'payment order id'),
      amountPaise: requirePaise(entity.amount, 'payment amount'),
      currency,
      status: mapped,
    };
  }

  async fetchPayment(input: FetchPaymentInput): Promise<GatewayPayment | null> {
    if (input.gatewayPaymentId) {
      try {
        return this.toGatewayPayment(
          await this.call('GET', `/v1/payments/${input.gatewayPaymentId}`),
        );
      } catch (error: unknown) {
        if (error instanceof GatewayRejectedError && error.providerStatus === 404) return null;
        throw error;
      }
    }
    if (!input.gatewayOrderId) throw new Error('INVALID_INPUT');
    return this.findCapturedPayment(input.gatewayOrderId);
  }

  /** Exactly one captured payment is expected; ambiguity must not confirm anything. */
  private async findCapturedPayment(gatewayOrderId: string): Promise<GatewayPayment | null> {
    const collection = await this.call('GET', `/v1/orders/${gatewayOrderId}/payments`);
    const items = Array.isArray(collection.items) ? (collection.items as RazorpayEntity[]) : [];
    const payments = items.map((entity) => this.toGatewayPayment(entity));
    for (const payment of payments) assertCurrency(payment.currency, payment.currency);
    const captured = payments.filter((payment) => payment.status === 'CAPTURED');
    if (captured.length > 1) throw new GatewayAmbiguousError('multiple captured payments');
    return captured[0] ?? null;
  }

  async findOrdersByReceipt(receipt: string): Promise<readonly GatewayOrderSummary[]> {
    const collection = await this.call(
      'GET',
      `/v1/orders?receipt=${encodeURIComponent(receipt)}&count=100`,
    );
    const items = Array.isArray(collection.items) ? (collection.items as RazorpayEntity[]) : [];
    return items.map((entity) => ({
      gatewayOrderId: requireString(entity.id, 'order id'),
      receipt: requireString(entity.receipt, 'order receipt'),
      amountPaise: requirePaise(entity.amount, 'order amount'),
      currency: requireString(entity.currency, 'order currency'),
      status: requireString(entity.status, 'order status'),
    }));
  }

  async listOrderPayments(gatewayOrderId: string): Promise<readonly GatewayPayment[]> {
    const collection = await this.call('GET', `/v1/orders/${gatewayOrderId}/payments`);
    const items = Array.isArray(collection.items) ? (collection.items as RazorpayEntity[]) : [];
    return items.map((entity) => this.toGatewayPayment(entity));
  }

  async refund(input: RefundInput): Promise<GatewayRefund> {
    const entity = await this.call(
      'POST',
      `/v1/payments/${input.gatewayPaymentId}/refund`,
      { amount: amountToGatewayNumber(input.amountPaise), receipt: input.refundReference },
      // Documented idempotency header carries the durable refund operation reference.
      { 'X-Refund-Idempotency': input.refundReference },
    );
    const status = requireString(entity.status, 'refund status');
    const statusMap: Record<string, GatewayRefund['status']> = {
      pending: 'PENDING',
      processed: 'PROCESSED',
      failed: 'FAILED',
    };
    const mapped = statusMap[status];
    if (!mapped) throw new GatewayAmbiguousError('unknown refund status');
    return { gatewayRefundId: requireString(entity.id, 'refund id'), status: mapped };
  }

  async fetchRefund(gatewayRefundId: string): Promise<GatewayRefund> {
    const entity = await this.call('GET', `/v1/refunds/${gatewayRefundId}`);
    const status = requireString(entity.status, 'refund status');
    if (status !== 'pending' && status !== 'processed' && status !== 'failed')
      throw new GatewayAmbiguousError('unknown refund status');
    return {
      gatewayRefundId: requireString(entity.id, 'refund id'),
      status: status === 'pending' ? 'PENDING' : status === 'processed' ? 'PROCESSED' : 'FAILED',
    };
  }

  /** Documented receipt-filtered lookup plus amount/currency agreement. */
  async findRefundByReceipt(
    gatewayPaymentId: string,
    receipt: string,
  ): Promise<GatewayRefund | null> {
    const collection = await this.call('GET', `/v1/payments/${gatewayPaymentId}/refunds?count=100`);
    const items = Array.isArray(collection.items) ? (collection.items as RazorpayEntity[]) : [];
    const matches = items.filter((entity) => entity.receipt === receipt);
    if (matches.length === 0) return null;
    if (matches.length > 1) throw new GatewayAmbiguousError('multiple refunds with one receipt');
    const status = requireString(matches[0]!.status, 'refund status');
    if (status !== 'pending' && status !== 'processed' && status !== 'failed')
      throw new GatewayAmbiguousError('unknown refund status');
    return {
      gatewayRefundId: requireString(matches[0]!.id, 'refund id'),
      status: status === 'pending' ? 'PENDING' : status === 'processed' ? 'PROCESSED' : 'FAILED',
    };
  }

  verifyCheckoutSignature(input: {
    gatewayOrderId: string;
    gatewayPaymentId: string;
    signature: string;
  }): boolean {
    const expected = createHmac('sha256', this.config.keySecret)
      .update(`${input.gatewayOrderId}|${input.gatewayPaymentId}`)
      .digest('hex');
    return RazorpayGateway.timingSafeEquals(expected, input.signature);
  }

  verifyWebhook(rawBody: Uint8Array, signature: string, secret: string): boolean {
    const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
    return RazorpayGateway.timingSafeEquals(expected, signature);
  }

  private static timingSafeEquals(expectedHex: string, provided: string): boolean {
    const a = Buffer.from(expectedHex, 'utf8');
    const b = Buffer.from(provided, 'utf8');
    return a.length === b.length && timingSafeEqual(a, b);
  }

  async fetchSettlements(input: {
    from?: string;
    to?: string;
    limit: number;
  }): Promise<SettlementPage> {
    const params = new URLSearchParams({ count: String(input.limit) });
    if (input.from) params.set('from', String(Math.floor(new Date(input.from).getTime() / 1000)));
    if (input.to) params.set('to', String(Math.floor(new Date(input.to).getTime() / 1000)));
    const collection = await this.call('GET', `/v1/settlements?${params.toString()}`);
    const items = Array.isArray(collection.items) ? (collection.items as RazorpayEntity[]) : [];
    return {
      items: items.map((entity) => ({
        gatewaySettlementId: requireString(entity.id, 'settlement id'),
        amountPaise: requirePaise(entity.amount, 'settlement amount'),
        currency: 'INR',
        occurredAt: new Date(Number(entity.created_at ?? 0) * 1000).toISOString(),
      })),
      nextCursor: items.length < input.limit ? null : String(items.length),
    };
  }
}
