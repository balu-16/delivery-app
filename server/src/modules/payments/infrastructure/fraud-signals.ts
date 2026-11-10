import { sql } from 'kysely';
import type { Database } from '../../../platform/database/database.js';
import type { PaymentFraudSignals } from '../contracts/payments.js';
import { FRAUD_VELOCITY_ORDERS_PER_HOUR } from '../domain/states.js';
import { recordFraudSignal } from './findings.js';

/**
 * Fraud signals v1 (Section 26, D25): ADVISORY records only. Nothing here
 * blocks a payment, an order or a user - admins review signals and decide,
 * and every decision is audited elsewhere. The velocity bound is a structural
 * default pending the P12 configurable policy.
 */
export class PaymentFraudSignalService implements PaymentFraudSignals {
  constructor(private readonly db: Database) {}
  /** Two or more failed attempts on one order record one deduped signal. */
  async recordPaymentFailure(orderId: string, attemptId: string): Promise<void> {
    const rows = await sql<{ failed: string }>`SELECT count(*)::text AS failed FROM payment_attempts
      WHERE order_id=${orderId}::uuid AND status='FAILED'`.execute(this.db);
    if (Number(rows.rows[0]?.failed ?? '0') < 2) return;
    await recordFraudSignal(this.db, {
      userId: null,
      kind: 'REPEATED_PAYMENT_FAILURES',
      severity: 'WARN',
      reference: `order:${orderId}`,
      details: { orderId, failedAttempts: rows.rows[0]!.failed, attemptId },
    });
  }
  async recordCheckoutVelocity(userId: string, orderId: string): Promise<void> {
    const rows = await sql<{ n: string }>`SELECT count(*)::text AS n FROM orders
      WHERE user_id=${userId}::uuid AND placed_at >= clock_timestamp() - interval '1 hour'`.execute(
      this.db,
    );
    if (Number(rows.rows[0]?.n ?? '0') < FRAUD_VELOCITY_ORDERS_PER_HOUR) return;
    await recordFraudSignal(this.db, {
      userId,
      kind: 'CHECKOUT_VELOCITY',
      severity: 'WARN',
      reference: `velocity:${userId}:${new Date().toISOString().slice(0, 13)}`,
      details: { ordersLastHour: rows.rows[0]!.n, orderId },
    });
  }
}
