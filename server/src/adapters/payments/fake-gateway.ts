import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  GatewayAmbiguousError,
  GatewayRejectedError,
  GatewayTimeoutError,
  type CreateOrderInput,
  type FetchPaymentInput,
  type GatewayOrder,
  type GatewayOrderSummary,
  type GatewayPayment,
  type GatewayRefund,
  type GatewaySettlement,
  type PaymentGatewayPort,
  type RefundInput,
  type SettlementPage,
} from '../../modules/payments/contracts/gateway.js';

export type FakeCreateOutcome = 'CREATED' | 'TIMEOUT' | 'REJECTED' | 'UNAVAILABLE';
export type FakeRefundOutcome = 'PROCESSED' | 'PENDING' | 'FAILED' | 'TIMEOUT';
export interface FakePaymentEntity {
  paymentId: string;
  gatewayOrderId: string;
  amountPaise: string;
  currency: string;
  status: 'CAPTURED' | 'FAILED' | 'AUTHORIZED';
  occurredAt: string;
}
interface RecordedOrder extends GatewayOrderSummary {
  receipt: string;
  operationReference: string;
}
interface RecordedRefund {
  refundId: string;
  refundReference: string;
  gatewayPaymentId: string;
  amountPaise: string;
  status: GatewayRefund['status'];
}

const hex = '0123456789abcdef';
function deterministicSuffix(seed: string, length = 14): string {
  let state = 2166136261;
  for (const byte of Buffer.from(seed, 'utf8')) {
    state ^= byte;
    state = Math.imul(state, 16777619) >>> 0;
  }
  let suffix = '';
  while (suffix.length < length) {
    state = Math.imul(state ^ (state >>> 15), 2246822519) >>> 0;
    suffix += hex[state % 16];
  }
  return suffix;
}

/**
 * Deterministic local/test gateway (ADR 0007). Scripts outcomes per operation
 * reference and exposes webhook emission hooks so tests can drive duplicate,
 * out-of-order, changed-body, webhook-before-response and amount-mismatch
 * scenarios through the real inbox. Production rejects this provider in the
 * environment schema; it is never a placeholder for real provider behavior.
 */
export class FakeGateway implements PaymentGatewayPort {
  private readonly creates = new Map<string, FakeCreateOutcome>();
  private readonly refunds = new Map<string, FakeRefundOutcome>();
  private readonly orders: RecordedOrder[] = [];
  private readonly payments = new Map<string, FakePaymentEntity>();
  private readonly orderPayments = new Map<string, FakePaymentEntity[]>();
  private readonly refundRecords = new Map<string, RecordedRefund>();
  /**
   * Webhook secret used by emission hooks; the key secret backs the checkout
   * signature. Defaults keep the adapter self-contained in local composition.
   */
  constructor(
    private readonly webhookSecret = 'fake-webhook-secret',
    private readonly keySecret = 'keysecret',
  ) {}

  /** Script the outcome of the next create for one durable operation reference. */
  scriptCreate(operationReference: string, outcome: FakeCreateOutcome): void {
    this.creates.set(operationReference, outcome);
  }
  /** Script the outcome of the next refund for one durable refund reference. */
  scriptRefund(refundReference: string, outcome: FakeRefundOutcome): void {
    this.refunds.set(refundReference, outcome);
  }
  /** Registers an order as if it already existed at the provider (recovery tests). */
  seedOrder(summary: {
    gatewayOrderId: string;
    receipt: string;
    amountPaise: string;
    currency: string;
    status?: string;
  }): void {
    this.orders.push({
      gatewayOrderId: summary.gatewayOrderId,
      receipt: summary.receipt,
      amountPaise: summary.amountPaise,
      currency: summary.currency,
      status: summary.status ?? 'created',
      operationReference: summary.receipt,
    });
  }
  /** Recorded operations for test assertions. */
  createdOrders(): readonly GatewayOrderSummary[] {
    return [...this.orders];
  }
  recordedRefunds(): readonly RecordedRefund[] {
    return [...this.refundRecords.values()];
  }
  recordedPayments(): readonly FakePaymentEntity[] {
    return [...this.payments.values()];
  }

  async createOrder(input: CreateOrderInput): Promise<GatewayOrder> {
    const outcome = this.creates.get(input.operationReference) ?? 'CREATED';
    if (outcome === 'TIMEOUT') throw new GatewayTimeoutError('fake gateway create timed out');
    if (outcome === 'UNAVAILABLE') throw new GatewayRejectedError(503, 'fake gateway unavailable');
    if (outcome === 'REJECTED') throw new GatewayRejectedError(400, 'fake gateway rejected');
    const gatewayOrderId = `order_${deterministicSuffix(input.operationReference)}`;
    this.orders.push({
      gatewayOrderId,
      receipt: input.receipt ?? input.operationReference,
      amountPaise: input.amountPaise,
      currency: input.currency,
      status: 'created',
      operationReference: input.operationReference,
    });
    return { gatewayOrderId, status: 'CREATED' };
  }

  async fetchPayment(input: FetchPaymentInput): Promise<GatewayPayment | null> {
    const entity = input.gatewayPaymentId
      ? this.payments.get(input.gatewayPaymentId)
      : (this.orderPayments.get(input.gatewayOrderId ?? '') ?? []).find(
          (payment) => payment.status === 'CAPTURED',
        );
    if (!entity) return null;
    return {
      gatewayPaymentId: entity.paymentId,
      gatewayOrderId: entity.gatewayOrderId,
      amountPaise: entity.amountPaise,
      currency: entity.currency,
      status: entity.status,
    };
  }

  async findOrdersByReceipt(receipt: string): Promise<readonly GatewayOrderSummary[]> {
    return this.orders.filter((order) => order.receipt === receipt);
  }

  async listOrderPayments(gatewayOrderId: string): Promise<readonly GatewayPayment[]> {
    return (this.orderPayments.get(gatewayOrderId) ?? []).map((entity) => ({
      gatewayPaymentId: entity.paymentId,
      gatewayOrderId: entity.gatewayOrderId,
      amountPaise: entity.amountPaise,
      currency: entity.currency,
      status: entity.status,
    }));
  }

  async refund(input: RefundInput): Promise<GatewayRefund> {
    const outcome = this.refunds.get(input.refundReference) ?? 'PROCESSED';
    if (outcome === 'TIMEOUT') throw new GatewayTimeoutError('fake gateway refund timed out');
    if (outcome === 'FAILED') throw new GatewayRejectedError(400, 'fake gateway refund failed');
    const refundId = `rfnd_${deterministicSuffix(input.refundReference)}`;
    const status: GatewayRefund['status'] = outcome === 'PENDING' ? 'PENDING' : 'PROCESSED';
    this.refundRecords.set(refundId, {
      refundId,
      refundReference: input.refundReference,
      gatewayPaymentId: input.gatewayPaymentId,
      amountPaise: input.amountPaise,
      status,
    });
    return { gatewayRefundId: refundId, status };
  }

  async fetchRefund(gatewayRefundId: string): Promise<GatewayRefund> {
    const record = this.refundRecords.get(gatewayRefundId);
    if (!record) throw new GatewayRejectedError(404, 'unknown refund');
    return { gatewayRefundId: record.refundId, status: record.status };
  }

  async findRefundByReceipt(
    gatewayPaymentId: string,
    receipt: string,
  ): Promise<GatewayRefund | null> {
    const matches = [...this.refundRecords.values()].filter(
      (record) =>
        record.gatewayPaymentId === gatewayPaymentId && record.refundReference === receipt,
    );
    if (matches.length === 0) return null;
    if (matches.length > 1) throw new GatewayAmbiguousError('multiple refunds with one receipt');
    return { gatewayRefundId: matches[0]!.refundId, status: matches[0]!.status };
  }

  verifyCheckoutSignature(input: {
    gatewayOrderId: string;
    gatewayPaymentId: string;
    signature: string;
  }): boolean {
    return (
      FakeGateway.checkoutSignature(
        input.gatewayOrderId,
        input.gatewayPaymentId,
        this.keySecret,
      ) === input.signature
    );
  }

  /** Same composition the Razorpay adapter documents: HMAC(orderId|paymentId, key secret). */
  static checkoutSignature(
    gatewayOrderId: string,
    gatewayPaymentId: string,
    keySecret: string,
  ): string {
    return createHmac('sha256', keySecret)
      .update(`${gatewayOrderId}|${gatewayPaymentId}`)
      .digest('hex');
  }

  verifyWebhook(rawBody: Uint8Array, signature: string, secret: string): boolean {
    const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
    const a = Buffer.from(expected);
    const b = Buffer.from(signature);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  /** Builds a signed webhook body exactly as a provider would deliver it. */
  signedWebhook(
    body: Record<string, unknown>,
    secret = this.webhookSecret,
  ): { raw: Uint8Array; signature: string } {
    const raw = new TextEncoder().encode(JSON.stringify(body));
    return { raw, signature: createHmac('sha256', secret).update(raw).digest('hex') };
  }

  /** Registers a captured payment and returns the signed payment.captured webhook body. */
  emitCaptured(payment: {
    gatewayOrderId: string;
    amountPaise: string;
    currency?: string;
    paymentId?: string;
    eventId?: string;
  }): { raw: Uint8Array; signature: string; paymentId: string } {
    const paymentId = payment.paymentId ?? `pay_${deterministicSuffix(payment.gatewayOrderId)}`;
    const entity: FakePaymentEntity = {
      paymentId,
      gatewayOrderId: payment.gatewayOrderId,
      amountPaise: payment.amountPaise,
      currency: payment.currency ?? 'INR',
      status: 'CAPTURED',
      occurredAt: new Date().toISOString(),
    };
    this.payments.set(paymentId, entity);
    const list = this.orderPayments.get(payment.gatewayOrderId) ?? [];
    list.push(entity);
    this.orderPayments.set(payment.gatewayOrderId, list);
    const body = {
      event: 'payment.captured',
      contains: ['payment'],
      payload: {
        payment: {
          entity: {
            id: paymentId,
            entity: 'payment',
            order_id: payment.gatewayOrderId,
            amount: Number(payment.amountPaise),
            currency: entity.currency,
            status: 'captured',
          },
        },
      },
      created_at: Math.floor(Date.now() / 1000),
    };
    if (payment.eventId) Object.assign(body, { x_razorpay_event_id: payment.eventId });
    const signed = this.signedWebhook(body);
    return { raw: signed.raw, signature: signed.signature, paymentId };
  }

  /** Signed payment.failed webhook body for the same order. */
  emitFailed(input: {
    gatewayOrderId: string;
    amountPaise: string;
    paymentId?: string;
    eventId?: string;
  }): {
    raw: Uint8Array;
    signature: string;
  } {
    const paymentId =
      input.paymentId ?? `pay_${deterministicSuffix(`${input.gatewayOrderId}failed`)}`;
    const body = {
      event: 'payment.failed',
      contains: ['payment'],
      payload: {
        payment: {
          entity: {
            id: paymentId,
            entity: 'payment',
            order_id: input.gatewayOrderId,
            amount: Number(input.amountPaise),
            currency: 'INR',
            status: 'failed',
          },
        },
      },
      created_at: Math.floor(Date.now() / 1000),
    };
    if (input.eventId) Object.assign(body, { x_razorpay_event_id: input.eventId });
    const signed = this.signedWebhook(body);
    return { raw: signed.raw, signature: signed.signature };
  }

  /** Signed refund.processed webhook body carrying the provider refund id. */
  emitRefundProcessed(input: { gatewayPaymentId: string; refundId: string; amountPaise: string }): {
    raw: Uint8Array;
    signature: string;
  } {
    const body = {
      event: 'refund.processed',
      contains: ['refund'],
      payload: {
        refund: {
          entity: {
            id: input.refundId,
            entity: 'refund',
            payment_id: input.gatewayPaymentId,
            amount: Number(input.amountPaise),
            status: 'processed',
          },
        },
      },
      created_at: Math.floor(Date.now() / 1000),
    };
    const signed = this.signedWebhook(body);
    return { raw: signed.raw, signature: signed.signature };
  }

  async fetchSettlements(_input: {
    from?: string;
    to?: string;
    limit: number;
  }): Promise<SettlementPage> {
    // The fake provider settles nothing; reconciliation sees an empty page.
    const items: GatewaySettlement[] = [];
    return { items, nextCursor: null };
  }
}
