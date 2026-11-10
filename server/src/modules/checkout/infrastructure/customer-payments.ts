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
      const locked = await sql<{
        user_id: string;
        status: string;
        payment_method: string | null;
        live: boolean | null;
        amount: string;
        currency: string;
      }>`SELECT user_id::text,status,payment_method,expires_at>clock_timestamp() AS live,amount_due_paise::text AS amount,currency FROM orders WHERE id=${orderId}::uuid FOR UPDATE`.execute(
        tx,
      );
      const order = locked.rows[0];
      if (!order || order.user_id !== userId) throw new Error('ORDER_NOT_FOUND');
      const attempts = await this.payments.listAttempts(orderId, tx);
      const replay = attempts.find((item) => item.operationReference === operationReference);
      if (replay) return replay;
      if (order.status !== 'PENDING_PAYMENT' || order.payment_method !== 'GATEWAY' || !order.live)
        throw new Error('PAYMENT_WINDOW_EXPIRED');
      const last = attempts.at(-1);
      if (last && ['CREATED', 'AUTHORIZED', 'UNKNOWN'].includes(last.status)) return last;
      if (last?.status === 'CAPTURED') throw new Error('PAYMENT_STATE_INVALID');
      return this.payments.createAttempt({
        aggregateId: orderId,
        kind: 'ORDER_PAYMENT',
        amountPaise: order.amount,
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
    if (!this.gateway.verifyCheckoutSignature({ ...input, gatewayOrderId: attempt.gatewayOrderId }))
      throw new Error('PAYMENT_SIGNATURE_INVALID');
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
