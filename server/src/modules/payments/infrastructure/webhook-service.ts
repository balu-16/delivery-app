import { createHash } from 'node:crypto';
import { sql } from 'kysely';
import { appendEvent } from '../../../platform/outbox/outbox.js';
import { uuidV7 } from '../../../common/ids/ids.js';
import {
  type Database,
  type TransactionContext,
  transactionWithRetry,
  databaseTimeAfterLock,
} from '../../../platform/database/database.js';
import { type PaymentGatewayPort } from '../contracts/gateway.js';
import type {
  InboxEventView,
  PaymentWebhookIngest,
  WebhookIngestResult,
  WebhookInboxQuery,
} from '../contracts/payments.js';
import { parseGatewayEvent, type GatewayEvent } from '../domain/events.js';
import { findingSeverity, MAX_INBOX_ATTEMPTS, type QuarantineReason } from '../domain/states.js';
import { PostgresAttempts } from './postgres-attempts.js';
import { PostgresWebhookInbox, type InboxRow } from './postgres-inbox.js';
import type { PaymentRefundService } from './refund-service.js';
import { recordFinding, recordFraudSignal } from './findings.js';
import { recordCapture } from './capture-receipts.js';

/** Missing correlation is tolerated: the event retries until the attempt appears. */
export class RetryableWebhookError extends Error {}

/** Deterministic fallback when the provider event-id header is absent. */
function fallbackEventId(body: string): string {
  return `sha256-${createHash('sha256').update(body, 'utf8').digest('hex')}`;
}

export interface WebhookSecrets {
  readonly [gateway: string]: string;
}

/**
 * Raw webhook ingress and processing (plan 5.4.4, PAY-01..PAY-03). The exact
 * raw bytes are signature-verified, then persisted before any processing;
 * duplicates are no-ops; changed-body replays with the same event id are
 * quarantined; amount/currency mismatches quarantine the event without
 * touching the attempt, so an order is never confirmed from tampered data.
 * Processing happens after the HTTP acknowledgement via the payments concern
 * queue; the durable inbox rows make the ingest writable across Redis outages.
 */
export class PaymentWebhookService implements PaymentWebhookIngest, WebhookInboxQuery {
  constructor(
    private readonly db: Database,
    private readonly inbox: PostgresWebhookInbox,
    private readonly attempts: PostgresAttempts,
    private readonly refunds: PaymentRefundService,
    private readonly gateway: PaymentGatewayPort,
    private readonly secrets: WebhookSecrets,
    private readonly enqueue?: (inboxId: string) => Promise<void>,
  ) {}
  async ingest(input: {
    gateway: string;
    rawBody: Uint8Array;
    signature: string;
    eventIdHeader: string | null;
  }): Promise<WebhookIngestResult> {
    const body = new TextDecoder().decode(input.rawBody);
    const secret = this.secrets[input.gateway];
    if (!secret) throw new Error('INVALID_INPUT');
    const signatureValid = this.gateway.verifyWebhook(input.rawBody, input.signature, secret);
    const parsed = parseGatewayEvent(body);
    const eventId = signatureValid
      ? (input.eventIdHeader ?? fallbackEventId(body))
      : `invalid-${fallbackEventId(body)}`;
    let inserted: { inboxId: string; duplicate: boolean };
    try {
      inserted = await this.inbox.insert({
        gateway: input.gateway,
        eventId,
        eventType: parsed.kind === 'ok' ? parsed.event.type : null,
        body,
        signature: input.signature,
        signatureValid,
      });
    } catch (error: unknown) {
      if (error instanceof Error && error.message === 'INBOX_BODY_CHANGED') {
        await transactionWithRetry(this.db, async (tx) => {
          await recordFinding(tx, {
            kind: 'WEBHOOK_CHANGED_BODY',
            severity: 'CRITICAL',
            aggregateType: 'gateway_event_inbox',
            aggregateId: `${input.gateway}:${eventId}`,
            reference: `${input.gateway}:${eventId}`,
            details: { reason: 'same event id replayed with a different signed body' },
          });
        });
        return {
          inboxId: '',
          duplicate: false,
          accepted: false,
          state: 'QUARANTINED',
          quarantineReason: 'CHANGED_BODY',
        };
      }
      throw error;
    }
    if (inserted.duplicate && signatureValid)
      return { inboxId: inserted.inboxId, duplicate: true, accepted: true, state: 'PENDING' };
    if (!signatureValid) {
      await transactionWithRetry(this.db, async (tx) => {
        await this.inbox.quarantineTx(tx, inserted.inboxId, 'SIGNATURE_INVALID');
        await recordFinding(tx, {
          kind: 'WEBHOOK_SIGNATURE_INVALID',
          severity: 'CRITICAL',
          aggregateType: 'gateway_event_inbox',
          aggregateId: inserted.inboxId,
          reference: `${input.gateway}:${eventId}`,
          details: { reason: 'signature did not verify over the raw body' },
        });
      });
      return {
        inboxId: inserted.inboxId,
        duplicate: false,
        accepted: false,
        state: 'QUARANTINED',
        quarantineReason: 'SIGNATURE_INVALID',
      };
    }
    if (this.enqueue) await this.enqueue(inserted.inboxId).catch(() => undefined);
    return { inboxId: inserted.inboxId, duplicate: false, accepted: true, state: 'PENDING' };
  }
  /** Concern-queue entry point: idempotent, bounded, retry-tolerant. */
  async processOne(
    inboxId: string,
  ): Promise<'PROCESSED' | 'QUARANTINED' | 'RETRY_SCHEDULED' | 'SKIPPED'> {
    const claimed = await this.inbox.claim(inboxId);
    if (!claimed || !claimed.signature_valid) return 'SKIPPED';
    if (claimed.state !== 'PROCESSING') {
      if (claimed.state === 'PENDING' && claimed.attempts >= MAX_INBOX_ATTEMPTS) {
        await this.quarantineWithFinding(
          claimed,
          'UNMAPPED_EVENT',
          'bounded correlation attempts ran out',
        );
        return 'QUARANTINED';
      }
      return 'SKIPPED';
    }
    try {
      await this.db.transaction().execute(async (tx) => {
        const ownership = await sql<{
          id: string;
        }>`SELECT id FROM gateway_event_inbox WHERE id=${claimed.id}::uuid AND state='PROCESSING' AND signature_valid AND attempts=${claimed.attempts} FOR UPDATE`.execute(
          tx,
        );
        if (!ownership.rows.length) throw new RetryableWebhookError('claim expired');
        const parsed = parseGatewayEvent(claimed.body);
        if (parsed.kind === 'unparseable') {
          await this.quarantineInTx(tx, claimed, 'UNPARSEABLE');
          return;
        }
        if (parsed.event.type === 'UNMAPPED') {
          await this.quarantineInTx(tx, claimed, 'UNMAPPED_EVENT');
          return;
        }
        await this.applyEvent(tx, claimed, parsed.event);
        await this.inbox.completeTx(tx, claimed.id);
      });
      return 'PROCESSED';
    } catch (error: unknown) {
      await this.inbox.scheduleRetry(claimed.id, claimed.attempts);
      if (!(error instanceof RetryableWebhookError)) {
        await recordFinding(this.db, {
          kind: 'WEBHOOK_PROCESSING_FAILED',
          severity: 'WARN',
          aggregateType: 'gateway_event_inbox',
          aggregateId: claimed.id,
          reference: `${claimed.gateway}:${claimed.gateway_event_id}`,
          details: { reason: 'processing failed; bounded retry scheduled' },
        }).catch(() => undefined);
      }
      return 'RETRY_SCHEDULED';
    }
  }
  private async quarantineInTx(
    tx: TransactionContext,
    row: InboxRow,
    reason: QuarantineReason,
  ): Promise<void> {
    await this.inbox.quarantineTx(tx, row.id, reason);
    await recordFinding(tx, {
      kind: `WEBHOOK_QUARANTINED_${reason}`,
      severity: findingSeverity(reason),
      aggregateType: 'gateway_event_inbox',
      aggregateId: row.id,
      reference: `${row.gateway}:${row.gateway_event_id}`,
      details: { reason },
    });
  }
  private async quarantineWithFinding(
    row: InboxRow,
    reason: QuarantineReason,
    detail: string,
  ): Promise<void> {
    await transactionWithRetry(this.db, async (tx) => {
      await this.inbox.quarantineTx(tx, row.id, reason);
      await recordFinding(tx, {
        kind: `WEBHOOK_QUARANTINED_${reason}`,
        severity: findingSeverity(reason),
        aggregateType: 'gateway_event_inbox',
        aggregateId: row.id,
        reference: `${row.gateway}:${row.gateway_event_id}`,
        details: { reason, detail },
      });
    });
  }
  private async applyEvent(
    tx: TransactionContext,
    row: InboxRow,
    event: GatewayEvent,
  ): Promise<void> {
    if (event.refund) {
      const refund = event.refund;
      const found = await sql<{
        refund_reference: string;
      }>`SELECT refund_reference FROM payment_refunds
        WHERE gateway_refund_id=${refund.refundId}`.execute(tx);
      const reference = found.rows[0]?.refund_reference;
      if (!reference) throw new RetryableWebhookError('refund commitment not visible yet');
      if (event.type === 'refund.processed')
        await this.refunds.applyOutcome(reference, { status: 'PROCESSED' }, tx);
      else await this.refunds.applyOutcome(reference, { status: 'FAILED' }, tx);
      return;
    }
    if (!event.payment) throw new RetryableWebhookError('event carried no payment entity');
    await this.applyPaymentEvent(tx, row, event);
  }
  private async applyPaymentEvent(
    tx: TransactionContext,
    row: InboxRow,
    event: GatewayEvent,
  ): Promise<void> {
    const entity = event.payment!;
    const attempt = entity.gatewayOrderId
      ? await this.attempts.byGatewayOrderId(entity.gatewayOrderId)
      : null;
    if (!attempt) throw new RetryableWebhookError('attempt not visible yet');
    if (attempt.gateway !== row.gateway) throw new RetryableWebhookError('gateway mismatch');
    if (entity.amountPaise !== null && entity.amountPaise !== attempt.amount_paise) {
      await this.quarantineInTx(tx, row, 'AMOUNT_MISMATCH');
      return;
    }
    if (entity.currency !== null && entity.currency !== attempt.currency) {
      await this.quarantineInTx(tx, row, 'CURRENCY_MISMATCH');
      return;
    }
    const locked = await this.attempts.lockById(tx, attempt.id);
    if (!locked) throw new RetryableWebhookError('attempt locked');
    if (event.type === 'payment.failed') {
      if (locked.status === 'CAPTURED' || locked.status === 'FAILED') return;
      await this.attempts.transition(tx, locked.id, locked.status, 'FAILED', {
        failureCode: 'GATEWAY_FAILED',
      });
      await this.emitFunding(tx, locked, 'payments.funding.failed');
      if (locked.order_id) {
        const failures = await sql<{
          n: string;
        }>`SELECT count(*)::text AS n FROM payment_attempts WHERE order_id=${locked.order_id}::uuid AND status='FAILED'`.execute(
          tx,
        );
        if (Number(failures.rows[0]!.n) >= 2)
          await recordFraudSignal(tx, {
            userId: locked.user_id,
            kind: 'REPEATED_PAYMENT_FAILURES',
            severity: 'WARN',
            reference: `order:${locked.order_id}`,
            details: { orderId: locked.order_id, failedAttempts: failures.rows[0]!.n },
          });
      }
      return;
    }
    if (event.type === 'payment.authorized') {
      if (locked.status === 'CREATED')
        await this.attempts.transition(tx, locked.id, locked.status, 'AUTHORIZED', {});
      return;
    }
    // payment.captured / order.paid
    const receiptId = await recordCapture(tx, {
      attemptId: locked.id,
      orderId: locked.order_id,
      paymentId: entity.paymentId,
      amountPaise: locked.amount_paise,
      currency: locked.currency,
    });
    if (locked.status === 'CAPTURED') {
      if (locked.gateway_payment_id !== entity.paymentId) {
        await recordFinding(tx, {
          kind: 'DUPLICATE_CAPTURE',
          severity: 'CRITICAL',
          aggregateType: 'payment_attempt',
          aggregateId: locked.id,
          reference: `${locked.id}:${entity.paymentId}`,
          details: { gatewayPaymentId: entity.paymentId, reason: 'second capture for one attempt' },
        });
        if (receiptId && locked.order_id)
          await appendEvent(
            tx,
            {
              eventId: uuidV7(),
              eventType: 'payments.funding.captured',
              schemaVersion: 1,
              aggregateType: 'payment_capture',
              aggregateId: receiptId,
              aggregateVersion: '1',
              occurredAt: (await databaseTimeAfterLock(tx)).toISOString(),
              correlationId: locked.operation_reference,
              causationId: null,
              payload: {
                orderId: locked.order_id,
                attemptId: locked.id,
                gatewayPaymentId: entity.paymentId,
                amountPaise: locked.amount_paise,
                currency: locked.currency,
                additionalCapture: true,
              },
            },
            ['orders'],
          );
      }
      return;
    }
    await this.attempts.transition(tx, locked.id, locked.status, 'CAPTURED', {
      gatewayPaymentId: entity.paymentId,
    });
    const updated = {
      ...locked,
      status: 'CAPTURED' as const,
      gateway_payment_id: entity.paymentId,
    };
    if (locked.kind === 'WALLET_TOPUP')
      await appendEvent(
        tx,
        {
          eventId: uuidV7(),
          eventType: 'payments.topup.captured',
          schemaVersion: 1,
          aggregateType: 'wallet_topup',
          aggregateId: locked.aggregate_id,
          aggregateVersion: '1',
          occurredAt: (await databaseTimeAfterLock(tx)).toISOString(),
          correlationId: locked.operation_reference,
          causationId: null,
          payload: {
            attemptId: locked.id,
            aggregateId: locked.aggregate_id,
            userId: locked.user_id,
            amountPaise: locked.amount_paise,
            currency: locked.currency,
            gatewayPaymentId: entity.paymentId,
            operationReference: locked.operation_reference,
          },
        },
        ['wallet', 'notifications'],
      );
    else await this.emitFunding(tx, updated, 'payments.funding.captured');
  }
  private async emitFunding(
    tx: TransactionContext,
    attempt: {
      id: string;
      order_id: string | null;
      aggregate_id: string;
      amount_paise: string;
      currency: string;
      gateway_payment_id: string | null;
      operation_reference: string;
    },
    eventType: string,
  ): Promise<void> {
    await appendEvent(
      tx,
      {
        eventId: uuidV7(),
        eventType,
        schemaVersion: 1,
        aggregateType: 'payment_attempt',
        aggregateId: attempt.id,
        aggregateVersion: '1',
        occurredAt: (await databaseTimeAfterLock(tx)).toISOString(),
        correlationId: attempt.operation_reference,
        causationId: null,
        payload: {
          attemptId: attempt.id,
          orderId: attempt.order_id ?? attempt.aggregate_id,
          gatewayPaymentId: attempt.gateway_payment_id,
          amountPaise: attempt.amount_paise,
          currency: attempt.currency,
          operationReference: attempt.operation_reference,
        },
      },
      eventType === 'payments.funding.failed' ? ['orders', 'notifications'] : ['orders'],
    );
  }
  async inboxEvent(inboxId: string): Promise<InboxEventView | null> {
    const row = await this.inbox.byId(inboxId);
    if (!row) return null;
    return {
      inboxId: row.id,
      gateway: row.gateway,
      eventId: row.gateway_event_id,
      eventType: row.event_type ?? 'UNKNOWN',
      state: row.state,
      quarantineReason: row.quarantine_reason,
      attempts: row.attempts,
      createdAt: row.created_at.toISOString(),
    };
  }
  async dueEvents(limit: number): Promise<readonly InboxEventView[]> {
    const rows = await this.inbox.due(limit);
    return rows.map((row) => ({
      inboxId: row.id,
      gateway: row.gateway,
      eventId: row.gateway_event_id,
      eventType: row.event_type ?? 'UNKNOWN',
      state: row.state,
      quarantineReason: row.quarantine_reason,
      attempts: row.attempts,
      createdAt: row.created_at.toISOString(),
    }));
  }
}
