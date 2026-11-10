import { sql } from 'kysely';
import { uuidV7 } from '../../../common/ids/ids.js';
import type { TransactionContext } from '../../../platform/database/database.js';
import type { EventEnvelope } from '../../../platform/outbox/outbox.js';
import { type PaymentRefundOperations } from '../../payments/contracts/payments.js';
import { ORDERS_CONSUMER, type Actor, type OrderStatus } from '../contracts/orders.js';
import { OrderConfirmationService } from './order-confirmation.js';
import { PostgresOrderAggregate } from './postgres-orders.js';

/**
 * Outbox consumer `orders` (D18): a verified capture confirms a
 * PENDING_PAYMENT order; captures arriving after EXPIRED/CANCELLED are
 * refunded to the original method (reinstatement is a separate guarded path)
 * and duplicate captures fund nothing extra. Stale failure events can never
 * undo a capture or a confirmed order. Reinstatement runs INSIDE the consumer
 * transaction so reacquired obligations and the confirmation commit together.
 */
export class OrderPaymentEventConsumer {
  static readonly CONSUMER = ORDERS_CONSUMER;
  constructor(
    private readonly aggregate: PostgresOrderAggregate,
    private readonly confirmation: OrderConfirmationService,
    private readonly refunds: PaymentRefundOperations,
    private readonly reinstateOrder: (
      orderId: string,
      actor: Actor,
      tx: TransactionContext,
    ) => Promise<unknown>,
    private readonly expirePending?: (orderId: string, tx: TransactionContext) => Promise<boolean>,
  ) {}
  async handle(tx: TransactionContext, event: EventEnvelope): Promise<void> {
    if (event.eventType === 'payments.funding.captured')
      await this.onCaptured(tx, event.payload as Record<string, unknown>);
    else if (event.eventType === 'payments.funding.failed')
      await this.onFailed(tx, event.payload as Record<string, unknown>);
    // Unknown event types are ignored: consumers only apply their own schema.
  }
  private async onCaptured(
    tx: TransactionContext,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const orderId = typeof payload['orderId'] === 'string' ? payload['orderId'] : null;
    const attemptId = typeof payload['attemptId'] === 'string' ? payload['attemptId'] : null;
    const gatewayPaymentId =
      typeof payload['gatewayPaymentId'] === 'string' ? payload['gatewayPaymentId'] : null;
    const amountPaise = typeof payload['amountPaise'] === 'string' ? payload['amountPaise'] : null;
    if (!orderId || !attemptId || !amountPaise) throw new Error('UNPARSEABLE_EVENT');
    let row = await this.aggregate.lock(tx, orderId);
    if (!row) throw new Error('ORDER_NOT_FOUND');
    if (row.status === 'PENDING_PAYMENT' && (await this.expirePending?.(orderId, tx))) {
      row = await this.aggregate.lock(tx, orderId);
      if (!row) throw new Error('ORDER_NOT_FOUND');
    }
    const funding = await sql<{
      gateway_payment_id: string;
    }>`SELECT gateway_payment_id FROM payment_capture_receipts
      WHERE attempt_id=${attemptId}::uuid AND order_id=${orderId}::uuid AND gateway_payment_id=${gatewayPaymentId}
      AND amount_paise=${amountPaise}::bigint`.execute(tx);
    if (!funding.rows.length) throw new Error('PAYMENT_FUNDING_INVALID');
    const used = row.metadata['fundingPaymentId'];
    if (used === gatewayPaymentId) return;
    if (row.status === 'PENDING_PAYMENT' && payload['additionalCapture'] !== true) {
      await this.confirmation.confirm(
        orderId,
        { kind: 'GATEWAY', attemptId, gatewayPaymentId },
        tx,
      );
      return;
    }
    if (row.status === 'EXPIRED' && row.cancel_reason === null) {
      const flag = await sql<{ enabled: boolean }>`SELECT enabled FROM feature_flags
        WHERE key='reinstate_expired_orders'`.execute(tx);
      if (flag.rows[0]?.enabled === true) {
        await sql`SAVEPOINT reinstate_order`.execute(tx);
        try {
          await this.reinstateOrder(orderId, { type: 'SYSTEM', id: null }, tx);
          await sql`UPDATE orders SET metadata=metadata||${JSON.stringify({ fundingPaymentId: gatewayPaymentId, fundingAttemptId: attemptId })}::jsonb WHERE id=${orderId}::uuid`.execute(
            tx,
          );
          await sql`RELEASE SAVEPOINT reinstate_order`.execute(tx);
          return;
        } catch {
          await sql`ROLLBACK TO SAVEPOINT reinstate_order`.execute(tx);
          await sql`RELEASE SAVEPOINT reinstate_order`.execute(tx);
        }
      }
    }
    if (
      [
        'CANCELLED',
        'EXPIRED',
        'CONFIRMED',
        'PICKING',
        'PACKED',
        'OUT_FOR_DELIVERY',
        'DELIVERED',
        'RETURNED_TO_STORE',
        'PAYMENT_FAILED',
      ].includes(row.status) ||
      payload['additionalCapture'] === true
    ) {
      // Late or duplicate capture: money received without a fundable order
      // slot is refunded to the original method (D18), never double credited.
      await this.refunds.commit({
        refundReference: `capture:${orderId}:${gatewayPaymentId}`,
        orderId,
        sourceType: 'GATEWAY_CAPTURE',
        sourceId: gatewayPaymentId ?? attemptId,
        amountPaise,
        destination: 'GATEWAY',
        gatewayPaymentId: gatewayPaymentId ?? undefined,
        reason:
          used || payload['additionalCapture'] === true ? 'DUPLICATE_CAPTURE' : 'LATE_CAPTURE',
        tx,
      });
      const kind = row.status === 'CONFIRMED' ? 'DUPLICATE_CAPTURE_REFUND' : 'LATE_CAPTURE_REFUND';
      await sql`INSERT INTO order_adjustments(id,order_id,kind,amount_paise,reason,adjustment_reference)
        VALUES (${uuidV7()}::uuid,${orderId}::uuid,${kind},${amountPaise}::bigint,${reasonOf(row.status)},${uuidV7()})`.execute(
        tx,
      );
      // No external call inside the consumer transaction: the refund stays a
      // reserved commitment and the P6.6 refund-recovery worker dispatches it
      // with the same vendor idempotency reference.
    }
  }
  private async onFailed(tx: TransactionContext, payload: Record<string, unknown>): Promise<void> {
    const orderId = typeof payload['orderId'] === 'string' ? payload['orderId'] : null;
    if (!orderId) return;
    const row = await this.aggregate.lock(tx, orderId);
    if (!row || row.status !== 'PENDING_PAYMENT') return; // D18: stale failure cannot unpay
    await sql`UPDATE orders SET payment_status='UNPAID' WHERE id=${orderId}::uuid AND payment_status='PAID' AND status='PENDING_PAYMENT'`.execute(
      tx,
    );
    await this.aggregate.history(
      tx,
      orderId,
      'PENDING_PAYMENT',
      'PENDING_PAYMENT',
      'PAYMENT_FAILED_EVENT',
      {
        type: 'SYSTEM',
        id: null,
      },
    );
  }
}
function reasonOf(status: OrderStatus): string {
  return status === 'CONFIRMED'
    ? 'duplicate capture refunded'
    : 'capture after terminal order state';
}
