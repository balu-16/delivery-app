import { sql } from 'kysely';
import { appendEvent } from '../../../platform/outbox/outbox.js';
import { uuidV7 } from '../../../common/ids/ids.js';
import {
  databaseTimeAfterLock,
  transactionWithRetry,
  type Database,
} from '../../../platform/database/database.js';
import type { PaymentGatewayPort } from '../contracts/gateway.js';
import { MAX_REFUND_RECOVERY_ATTEMPTS } from '../domain/states.js';
import { recordFinding } from './findings.js';
import type { PostgresAttempts } from './postgres-attempts.js';
import { recordCapture } from './capture-receipts.js';

/** Backoff gate between recovery passes; attempts are bounded per refund. */
const RECOVERY_BACKOFF_SECONDS = 60;

/**
 * Payment poller (PAY-01, plan 20.2): PENDING_PAYMENT orders nearing or past
 * their payment window are checked against the gateway so a missing webhook
 * still confirms (or fails) the payment. The guarded path mirrors the
 * webhook correlation rules (D18): stale failures never unpay, duplicate
 * captures become findings, and every transition emits the same funding
 * events the `orders` consumer applies.
 */
export class PaymentPollerService {
  constructor(
    private readonly db: Database,
    private readonly attempts: PostgresAttempts,
    private readonly gateway: PaymentGatewayPort,
  ) {}
  /** Returns the number of attempts authoritatively refreshed. */
  async pollNearExpiry(limit: number, windowSeconds: number): Promise<number> {
    const due = await sql<{ id: string }>`SELECT DISTINCT a.id::text AS id FROM payment_attempts a
      LEFT JOIN orders o ON o.id = a.order_id
      WHERE (o.status IN ('PENDING_PAYMENT','EXPIRED','PAYMENT_FAILED','CANCELLED') OR a.kind='WALLET_TOPUP')
        AND a.status IN ('CREATED','AUTHORIZED','UNKNOWN','FAILED')
        AND a.gateway_order_id IS NOT NULL
        AND (o.expires_at IS NULL OR o.expires_at <= clock_timestamp() + ${windowSeconds} * interval '1 second')
      ORDER BY id LIMIT ${limit}`.execute(this.db);
    let refreshed = 0;
    for (const row of due.rows)
      refreshed += (await this.pollAttempt(row.id).catch(() => false)) ? 1 : 0;
    return refreshed;
  }
  /** One authoritative gateway fetch; applies the outcome under the attempt lock. */
  async pollAttempt(attemptId: string, gatewayPaymentId?: string): Promise<boolean> {
    const candidate = await this.attempts.byId(attemptId);
    if (!candidate?.gateway_order_id) return false;
    const fetched = await this.gateway.fetchPayment(
      gatewayPaymentId ? { gatewayPaymentId } : { gatewayOrderId: candidate.gateway_order_id },
    );
    return transactionWithRetry(this.db, async (tx) => {
      const locked = await this.attempts.lockById(tx, attemptId);
      if (!locked || !locked.gateway_order_id) return false;
      if (
        !['CREATED', 'AUTHORIZED', 'UNKNOWN', 'FAILED'].includes(locked.status) ||
        locked.gateway_order_id !== candidate.gateway_order_id
      )
        return false;
      await this.attempts.countExternalAttempt(tx, attemptId);
      if (
        fetched &&
        ((gatewayPaymentId && fetched.gatewayPaymentId !== gatewayPaymentId) ||
          fetched.amountPaise !== locked.amount_paise ||
          fetched.currency !== locked.currency ||
          fetched.gatewayOrderId !== locked.gateway_order_id)
      ) {
        await recordFinding(tx, {
          kind: 'POLL_PAYMENT_MISMATCH',
          severity: 'CRITICAL',
          aggregateType: 'payment_attempt',
          aggregateId: locked.id,
          reference: locked.id,
          details: { reason: 'authoritative payment ID, amount, currency or order did not match' },
        });
        return false;
      }
      if (fetched && fetched.status === 'CAPTURED') {
        await recordCapture(tx, {
          attemptId: locked.id,
          orderId: locked.order_id,
          paymentId: fetched.gatewayPaymentId,
          amountPaise: locked.amount_paise,
          currency: locked.currency,
        });
        await this.attempts.transition(tx, locked.id, locked.status, 'CAPTURED', {
          gatewayPaymentId: fetched.gatewayPaymentId,
        });
        await appendEvent(
          tx,
          {
            eventId: uuidV7(),
            eventType:
              locked.kind === 'WALLET_TOPUP'
                ? 'payments.topup.captured'
                : 'payments.funding.captured',
            schemaVersion: 1,
            aggregateType: 'payment_attempt',
            aggregateId: locked.id,
            aggregateVersion: '1',
            occurredAt: (await databaseTimeAfterLock(tx)).toISOString(),
            correlationId: locked.operation_reference,
            causationId: null,
            payload: {
              attemptId: locked.id,
              orderId: locked.order_id ?? locked.aggregate_id,
              aggregateId: locked.aggregate_id,
              userId: locked.user_id,
              gatewayPaymentId: fetched.gatewayPaymentId,
              amountPaise: locked.amount_paise,
              currency: locked.currency,
              operationReference: locked.operation_reference,
            },
          },
          locked.kind === 'WALLET_TOPUP' ? ['wallet', 'notifications'] : ['orders'],
        );
        return true;
      }
      if (fetched && fetched.status === 'FAILED' && locked.status === 'CREATED') {
        await this.attempts.transition(tx, locked.id, locked.status, 'FAILED', {
          failureCode: 'GATEWAY_FAILED',
        });
        await appendEvent(
          tx,
          {
            eventId: uuidV7(),
            eventType: 'payments.funding.failed',
            schemaVersion: 1,
            aggregateType: 'payment_attempt',
            aggregateId: locked.id,
            aggregateVersion: '1',
            occurredAt: (await databaseTimeAfterLock(tx)).toISOString(),
            correlationId: locked.operation_reference,
            causationId: null,
            payload: {
              attemptId: locked.id,
              orderId: locked.order_id ?? locked.aggregate_id,
              aggregateId: locked.aggregate_id,
              userId: locked.user_id,
              gatewayPaymentId: null,
              amountPaise: locked.amount_paise,
              currency: locked.currency,
              operationReference: locked.operation_reference,
            },
          },
          ['orders', 'notifications'],
        );
        return true;
      }
      return false; // authoritative "still not captured"; the window sweeper handles expiry
    });
  }
}

/**
 * Refund recovery (PAY-06/07): PENDING and UNKNOWN gateway refunds are
 * re-driven with the SAME vendor idempotency reference; UNKNOWN outcomes are
 * resolved through the documented lookup; after the bounded attempt count a
 * finding escalates to admin review - never a speculative wallet credit.
 */
export class RefundRecoveryService {
  constructor(
    private readonly db: Database,
    private readonly refunds: {
      dispatchRefund(refundReference: string): Promise<unknown>;
      recoverUnknown(refundReference: string): Promise<unknown>;
    },
  ) {}
  async recoverBatch(limit: number): Promise<number> {
    const due = await sql<{
      refund_reference: string;
      status: string;
    }>`SELECT refund_reference, status
      FROM payment_refunds
      WHERE destination='GATEWAY' AND status IN ('PENDING','UNKNOWN')
        AND external_attempts < ${MAX_REFUND_RECOVERY_ATTEMPTS}
        AND updated_at <= clock_timestamp() - ${RECOVERY_BACKOFF_SECONDS} * interval '1 second'
      ORDER BY created_at LIMIT ${limit}`.execute(this.db);
    let processed = 0;
    for (const row of due.rows) {
      // A pass counts as an attempt unless the refund reached a terminal
      // state; transient unavailability therefore also escalates eventually.
      const before = await sql<{ status: string }>`SELECT status FROM payment_refunds
        WHERE refund_reference=${row.refund_reference}`.execute(this.db);
      try {
        if (row.status === 'PENDING') await this.refunds.dispatchRefund(row.refund_reference);
        else await this.refunds.recoverUnknown(row.refund_reference);
      } catch {
        // recorded below; the next pass re-drives with the same reference
      }
      const after = await sql<{ status: string }>`SELECT status FROM payment_refunds
        WHERE refund_reference=${row.refund_reference}`.execute(this.db);
      if (after.rows[0]?.status && ['PENDING', 'UNKNOWN'].includes(after.rows[0].status))
        await this.recordAttempt(row.refund_reference);
      if (after.rows[0]?.status !== before.rows[0]?.status) processed += 1;
    }
    return processed;
  }
  private async recordAttempt(reference: string): Promise<void> {
    await transactionWithRetry(this.db, async (tx) => {
      const updated = await sql<{ id: string; external_attempts: number }>`UPDATE payment_refunds
        SET external_attempts = external_attempts + 1, updated_at = clock_timestamp()
        WHERE refund_reference=${reference} AND status IN ('PENDING','UNKNOWN')
        RETURNING id::text AS id, external_attempts`.execute(tx);
      const row = updated.rows[0];
      if (row && row.external_attempts >= MAX_REFUND_RECOVERY_ATTEMPTS)
        await recordFinding(tx, {
          kind: 'REFUND_RECOVERY_EXHAUSTED',
          severity: 'CRITICAL',
          aggregateType: 'payment_refund',
          aggregateId: row.id,
          reference,
          details: { attempts: row.external_attempts },
        });
    });
  }
}
