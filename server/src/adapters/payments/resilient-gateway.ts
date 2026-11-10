import {
  GatewayRejectedError,
  GatewayUnavailableError,
  isGatewayAmbiguous,
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

/**
 * Circuit breaker wrapper (Section 7 rules). Repeated transport failures open
 * the breaker for a cooldown; typed ambiguity/rejection results pass through.
 * It never retries by itself: create and refund are non-idempotent effects
 * whose retries belong to the durable-operation layer.
 */
export class ResilientGateway implements PaymentGatewayPort {
  private failures = 0;
  private openUntil = 0;
  private probing = false;
  constructor(
    private readonly inner: PaymentGatewayPort,
    private readonly threshold = 5,
    private readonly cooldownMs = 30000,
    private readonly now: () => number = Date.now,
  ) {}
  private async call<T>(operation: () => Promise<T>): Promise<T> {
    if (this.now() < this.openUntil) throw new GatewayUnavailableError('gateway breaker is open');
    const probe = this.failures >= this.threshold;
    if (probe && this.probing) throw new GatewayUnavailableError('gateway breaker is probing');
    if (probe) this.probing = true;
    try {
      const result = await operation();
      this.failures = 0;
      this.openUntil = 0;
      return result;
    } catch (error: unknown) {
      const rejected = error instanceof GatewayRejectedError;
      const transport = error instanceof GatewayUnavailableError || isGatewayAmbiguous(error);
      if (rejected) {
        this.failures = 0;
        this.openUntil = 0;
      } else if (transport && ++this.failures >= this.threshold) {
        this.openUntil = this.now() + this.cooldownMs;
      }
      throw error;
    } finally {
      if (probe) this.probing = false;
    }
  }
  createOrder(input: CreateOrderInput): Promise<GatewayOrder> {
    return this.call(() => this.inner.createOrder(input));
  }
  fetchPayment(input: FetchPaymentInput): Promise<GatewayPayment | null> {
    return this.call(() => this.inner.fetchPayment(input));
  }
  findOrdersByReceipt(receipt: string): Promise<readonly GatewayOrderSummary[]> {
    return this.call(() => this.inner.findOrdersByReceipt(receipt));
  }
  listOrderPayments(gatewayOrderId: string): Promise<readonly GatewayPayment[]> {
    return this.call(() => this.inner.listOrderPayments(gatewayOrderId));
  }
  refund(input: RefundInput): Promise<GatewayRefund> {
    return this.call(() => this.inner.refund(input));
  }
  fetchRefund(gatewayRefundId: string): Promise<GatewayRefund> {
    return this.call(() => this.inner.fetchRefund(gatewayRefundId));
  }
  findRefundByReceipt(gatewayPaymentId: string, receipt: string): Promise<GatewayRefund | null> {
    return this.call(() => this.inner.findRefundByReceipt(gatewayPaymentId, receipt));
  }
  verifyCheckoutSignature(input: {
    gatewayOrderId: string;
    gatewayPaymentId: string;
    signature: string;
  }): boolean {
    return this.inner.verifyCheckoutSignature(input);
  }
  verifyWebhook(rawBody: Uint8Array, signature: string, secret: string): boolean {
    return this.inner.verifyWebhook(rawBody, signature, secret);
  }
  fetchSettlements(input: { from?: string; to?: string; limit: number }): Promise<SettlementPage> {
    return this.call(() => this.inner.fetchSettlements(input));
  }
}
