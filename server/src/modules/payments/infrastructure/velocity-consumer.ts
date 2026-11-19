import { sql } from 'kysely';
import type { TransactionContext } from '../../../platform/database/database.js';
import type { EventEnvelope } from '../../../platform/outbox/outbox.js';
import { FRAUD_VELOCITY_ORDERS_PER_HOUR } from '../domain/states.js';
import { recordFraudSignal } from './findings.js';

/** Consumer name for the durable checkout-velocity obligation. */
export const CHECKOUT_VELOCITY_CONSUMER = 'checkout-velocity';

/**
 * Advisory checkout-velocity check (D25). Runs once per committed placement
 * through `consumeOnce`, so a replay never records a second signal for the
 * same event. The one-hour window and threshold match the previous
 * synchronous countdown exactly.
 */
export class CheckoutVelocityConsumer {
  static readonly CONSUMER = CHECKOUT_VELOCITY_CONSUMER;
  async handle(tx: TransactionContext, event: EventEnvelope): Promise<void> {
    if (event.eventType !== 'checkout.velocity_check') return;
    const payload = event.payload as { userId?: unknown; orderId?: unknown };
    const userId = typeof payload.userId === 'string' ? payload.userId : null;
    const orderId = typeof payload.orderId === 'string' ? payload.orderId : null;
    if (
      !userId ||
      !orderId ||
      !/^[0-9a-f-]{36}$/i.test(userId) ||
      !/^[0-9a-f-]{36}$/i.test(orderId)
    )
      throw new Error('INVALID_VELOCITY_EVENT');
    const rows = await sql<{ n: string }>`SELECT count(*)::text AS n FROM orders
      WHERE user_id=${userId}::uuid AND placed_at >= clock_timestamp() - interval '1 hour'`.execute(
      tx,
    );
    if (Number(rows.rows[0]?.n ?? '0') < FRAUD_VELOCITY_ORDERS_PER_HOUR) return;
    await recordFraudSignal(tx, {
      userId,
      kind: 'CHECKOUT_VELOCITY',
      severity: 'WARN',
      reference: `velocity:${userId}:${new Date().toISOString().slice(0, 13)}`,
      details: { ordersLastHour: rows.rows[0]!.n, orderId },
    });
  }
}
