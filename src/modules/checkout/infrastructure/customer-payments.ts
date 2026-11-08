import { createHash } from 'node:crypto';
import { sql } from 'kysely';
import { transactionWithRetry, type Database } from '../../../platform/database/database.js';
import type { OrderOperations } from '../../orders/contracts/orders.js';
import type {
  PaymentOrderOperations,
  PaymentVerification,
} from '../../payments/contracts/payments.js';
import type { PaymentGatewayPort } from '../../payments/contracts/gateway.js';
import type { CustomerPayments } from '../contracts/customer-payments.js';
import type { CheckoutOperations } from '../contracts/checkout.js';

/** Customer hints never establish funding: verification always fetches the provider. */
export class CustomerPaymentService implements CustomerPayments {
  constructor(
    private readonly db: Database,
    private readonly orders: OrderOperations,
    private readonly payments: PaymentOrderOperations,
    private readonly gateway: PaymentGatewayPort,
    private readonly verification: PaymentVerification,
    private readonly checkout: CheckoutOperations,
  ) {}
  async retry(userId: string, orderId: string, key: string) {
    if (!key || key.length > 150) throw new Error('INVALID_INPUT');
    const operationReference = `order-${createHash('sha256')
      .update(JSON.stringify([userId, orderId, key]))
      .digest('hex')
      .slice(0, 32)}`;
    const attempt = await transactionWithRetry(this.db, async (tx) => {
      await sql`SELECT id FROM orders WHERE id=${orderId}::uuid FOR UPDATE`.execute(tx);
      const order = await this.orders.byId(orderId, { userId, tx });
      if (!order) throw new Error('ORDER_NOT_FOUND');
      const replay = await this.payments.intentByOperationReference(operationReference);
      if (replay) return replay;
      const window =
        await sql`SELECT id FROM orders WHERE id=${orderId}::uuid AND status='PENDING_PAYMENT'
     AND payment_method='GATEWAY' AND expires_at>clock_timestamp()`.execute(tx);
      if (!window.rows.length) throw new Error('PAYMENT_WINDOW_EXPIRED');
      const attempts = await this.payments.listAttempts(orderId),
        last = attempts.at(-1);
      if (last && ['CREATED', 'AUTHORIZED', 'UNKNOWN'].includes(last.status)) return last;
      if (last?.status === 'CAPTURED') throw new Error('PAYMENT_STATE_INVALID');
      return this.payments.createAttempt({
        aggregateId: orderId,
        kind: 'ORDER_PAYMENT',
        amountPaise: order.amountDuePaise,
        currency: order.currency,
        userId,
        operationReference,
        tx,
      });
    });
    return this.checkout.completePaymentSetup(
      attempt.operationReference,
      attempt.operationReference,
    );
  }
  async verify(
    userId: string,
    orderId: string,
    input: {
      attemptId: string;
      gatewayOrderId: string;
      gatewayPaymentId: string;
      signature: string;
    },
  ) {
    await this.owned(userId, orderId);
    const attempt = (await this.payments.listAttempts(orderId)).find(
      (a) => a.attemptId === input.attemptId,
    );
    if (!attempt || attempt.gatewayOrderId !== input.gatewayOrderId)
      throw new Error('PAYMENT_FUNDING_INVALID');
    if (!this.gateway.verifyCheckoutSignature(input)) throw new Error('PAYMENT_SIGNATURE_INVALID');
    await this.verification.pollAttempt(attempt.attemptId, input.gatewayPaymentId);
    const order = await this.owned(userId, orderId);
    return {
      order,
      attempt: (await this.payments.listAttempts(orderId)).find(
        (a) => a.attemptId === attempt.attemptId,
      )!,
    };
  }
  async status(userId: string, orderId: string) {
    return {
      order: await this.owned(userId, orderId),
      attempts: await this.payments.listAttempts(orderId),
    };
  }
  private async owned(userId: string, orderId: string) {
    const order = await this.orders.byId(orderId, { userId });
    if (!order) throw new Error('ORDER_NOT_FOUND');
    return order;
  }
}
