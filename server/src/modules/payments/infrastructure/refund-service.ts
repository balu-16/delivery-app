import { sql } from 'kysely';
import { createHash } from 'node:crypto';
import { appendEvent } from '../../../platform/outbox/outbox.js';
import { uuidV7 } from '../../../common/ids/ids.js';
import {
  type Database,
  type TransactionContext,
  transactionWithRetry,
} from '../../../platform/database/database.js';
import {
  GatewayRejectedError,
  GatewayUnavailableError,
  isGatewayAmbiguous,
  type PaymentGatewayPort,
} from '../contracts/gateway.js';
import type { AppConfig } from '../../app-config/contracts/config.js';
import type {
  CommitRefundInput,
  PaymentRefundOperations,
  RefundDestination,
  RefundOutcomeStatus,
  RefundSourceCapacity,
  RefundView,
} from '../contracts/payments.js';
import { newRefundReference } from '../domain/references.js';
import { PostgresRefunds, type RefundRow } from './postgres-refunds.js';
import type { DurableOperations } from './durable-ops.js';
import { recordFinding } from './findings.js';

function view(row: RefundRow): RefundView {
  return {
    refundId: row.id,
    refundReference: row.refund_reference,
    orderId: row.order_id,
    sourceType: row.source_type,
    sourceId: row.source_id,
    amountPaise: row.amount_paise,
    destination: row.destination,
    status: row.status,
    gatewayRefundId: row.gateway_refund_id,
    reason: row.reason,
  };
}
export function settledEventPayload(
  row: RefundRow,
  userId: string | null,
): Record<string, string | null> {
  return {
    refundId: row.id,
    refundReference: row.refund_reference,
    orderId: row.order_id,
    sourceType: row.source_type,
    sourceId: row.source_id,
    destination: row.destination,
    amountPaise: row.amount_paise,
    userId,
    reason: row.reason,
  };
}

/**
 * Refund commitments (D17/ADD-13): the commitment and its single allocation
 * commit before any external call; gateway destinations call the documented
 * idempotent refund endpoint; wallet-destination effects are applied by the
 * wallet module's idempotent consumer of `payments.refund.settled`, so a
 * refund can never both restore wallet spending and credit it again. UNKNOWN
 * keeps the capacity reserved and never credits the wallet.
 */
export class PaymentRefundService implements PaymentRefundOperations {
  constructor(
    private readonly db: Database,
    private readonly refunds: PostgresRefunds,
    private readonly durable: DurableOperations,
    private readonly gateway: PaymentGatewayPort,
    private readonly config: AppConfig,
  ) {}
  async commit(input: CommitRefundInput): Promise<RefundView> {
    if (input.refundReference && input.refundReference.length > 300)
      throw new Error('INVALID_INPUT');
    const refundReference = input.refundReference
      ? `refund-${createHash('sha256').update(input.refundReference).digest('hex').slice(0, 32)}`
      : newRefundReference();
    const row = await (input.tx
      ? this.commitTx(input.tx, input, refundReference)
      : transactionWithRetry(this.db, (tx) => this.commitTx(tx, input, refundReference)));
    if (input.tx) return view(row);
    if (row.destination === 'GATEWAY') {
      await this.dispatchRefund(row.refund_reference);
      return view((await this.refunds.byReference(row.refund_reference)) ?? row);
    }
    return view(row);
  }
  private async commitTx(
    tx: TransactionContext,
    input: CommitRefundInput,
    refundReference: string,
  ): Promise<RefundRow> {
    await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`refund:${refundReference}`},0))`.execute(
      tx,
    );
    const existing = await this.refunds.lockByReference(tx, refundReference);
    if (existing) {
      if (
        existing.order_id !== input.orderId ||
        existing.source_type !== input.sourceType ||
        existing.source_id !== input.sourceId ||
        existing.amount_paise !== input.amountPaise ||
        existing.destination !== input.destination ||
        existing.reason !== (input.reason ?? null)
      )
        throw new Error('IDEMPOTENCY_KEY_REUSED');
      return existing;
    }
    if (input.destination === 'GATEWAY' && !input.gatewayPaymentId)
      throw new Error('INVALID_INPUT');
    const attemptId =
      input.sourceType === 'GATEWAY_CAPTURE'
        ? ((
            await sql<{
              id: string;
            }>`SELECT attempt_id AS id FROM payment_capture_receipts WHERE gateway_payment_id=${input.sourceId} AND order_id=${input.orderId}::uuid LIMIT 1`.execute(
              tx,
            )
          ).rows[0]?.id ?? null)
        : null;
    await this.durable.create(tx, 'PAYMENT_REFUND', refundReference, {
      orderId: input.orderId,
      sourceType: input.sourceType,
      amountPaise: input.amountPaise,
    });
    const row = await this.refunds.commit(tx, {
      orderId: input.orderId,
      refundReference,
      sourceType: input.sourceType,
      sourceId: input.sourceId,
      attemptId,
      amountPaise: input.amountPaise,
      destination: input.destination,
      reason: input.reason ?? null,
      initiatedBy: input.initiatedBy ?? null,
    });
    await appendEvent(
      tx,
      {
        ...settledEvent(row, await ownerOf(tx, row.order_id)),
        eventType: 'payments.refund.initiated',
      },
      ['notifications'],
    );
    if (input.destination === 'WALLET') {
      // Wallet restorations are local; manual payouts stay pending until evidenced.
      const processed = await this.refunds.transition(tx, row.id, 'PENDING', 'PROCESSED', {});
      await appendEvent(tx, settledEvent(processed, await ownerOf(tx, processed.order_id)), [
        'wallet',
        'notifications',
        'invoicing',
      ]);
      return processed;
    }
    return row;
  }
  /** Drives (or re-drives) the idempotent external refund for one commitment. */
  async dispatchRefund(refundReference: string): Promise<RefundView> {
    // A session lock fences dispatch against webhook outcomes without holding
    // a database transaction open during the gateway call. Claim UNKNOWN first
    // so a crash at any point recovers only by provider lookup.
    const result = await this.db.connection().execute(async (connection) => {
      const lockKey = `refund-dispatch:${refundReference}`;
      const lock = await sql<{
        acquired: boolean;
      }>`SELECT pg_try_advisory_lock(hashtextextended(${lockKey},0)) AS acquired`.execute(
        connection,
      );
      if (!lock.rows[0]?.acquired) return null;
      try {
        const claim = await connection.transaction().execute(async (tx) => {
          const locked = await this.refunds.lockByReference(tx, refundReference);
          if (!locked) throw new Error('RESOURCE_NOT_FOUND');
          if (locked.status !== 'PENDING' || locked.destination !== 'GATEWAY')
            return { row: locked, claimed: false };
          return {
            row: await this.refunds.transition(tx, locked.id, 'PENDING', 'UNKNOWN', {}),
            claimed: true,
          };
        });
        const { row } = claim;
        if (!claim.claimed) return view(row);
        const apply = (outcome: { status: RefundOutcomeStatus; gatewayRefundId?: string }) =>
          connection
            .transaction()
            .execute((tx) => this.applyOutcomeTx(tx, refundReference, outcome));
        try {
          const outcome = await this.gateway.refund({
            refundReference,
            gatewayPaymentId: row.source_id,
            amountPaise: row.amount_paise,
          });
          return await apply({
            status: outcome.status === 'UNKNOWN' ? 'PENDING' : outcome.status,
            gatewayRefundId: outcome.gatewayRefundId ?? undefined,
          });
        } catch (error: unknown) {
          if (error instanceof GatewayRejectedError) {
            return apply({ status: 'FAILED' });
          }
          if (isGatewayAmbiguous(error)) {
            // The refund may or may not exist at the provider: the commitment stays
            // reserved as UNKNOWN until the documented lookup resolves it.
            return view(row);
          }
          if (error instanceof GatewayUnavailableError) return view(row);
          throw error;
        }
      } finally {
        await sql`SELECT pg_advisory_unlock(hashtextextended(${lockKey},0))`.execute(connection);
      }
    });
    if (result) return result;
    const current = await this.refunds.byReference(refundReference);
    if (!current) throw new Error('RESOURCE_NOT_FOUND');
    return view(current);
  }
  async applyOutcome(
    refundReference: string,
    outcome: { status: RefundOutcomeStatus; gatewayRefundId?: string },
    outer?: TransactionContext,
  ): Promise<RefundView> {
    const run = (tx: TransactionContext) => this.applyOutcomeTx(tx, refundReference, outcome);
    if (outer) return run(outer);
    return transactionWithRetry(this.db, run);
  }
  private async applyOutcomeTx(
    tx: TransactionContext,
    refundReference: string,
    outcome: { status: RefundOutcomeStatus; gatewayRefundId?: string },
  ): Promise<RefundView> {
    const fence = await sql<{
      acquired: boolean;
    }>`SELECT pg_try_advisory_xact_lock(hashtextextended(${`refund-dispatch:${refundReference}`},0)) AS acquired`.execute(
      tx,
    );
    if (!fence.rows[0]?.acquired) throw new Error('REFUND_OUTCOME_BUSY');
    const row = await this.refunds.lockByReference(tx, refundReference);
    if (!row) throw new Error('RESOURCE_NOT_FOUND');
    if (row.destination !== 'GATEWAY') throw new Error('INVALID_REFUND_DESTINATION');
    if (row.status === 'PROCESSED' || row.status === 'FAILED') return view(row);
    if (outcome.status === 'PENDING') {
      // A provider-accepted or ambiguous operation must be looked up, not
      // dispatched again while its first outcome is unresolved.
      if (row.status === 'UNKNOWN') {
        if (outcome.gatewayRefundId) {
          if (row.gateway_refund_id && row.gateway_refund_id !== outcome.gatewayRefundId)
            throw new Error('REFUND_CORRELATION_MISMATCH');
          await sql`UPDATE payment_refunds SET gateway_refund_id=${outcome.gatewayRefundId},updated_at=clock_timestamp()
            WHERE id=${row.id}::uuid AND gateway_refund_id IS NULL`.execute(tx);
          return view({ ...row, gateway_refund_id: outcome.gatewayRefundId });
        }
        return view(row);
      }
      return view(
        await this.refunds.transition(tx, row.id, 'PENDING', 'UNKNOWN', {
          gatewayRefundId: outcome.gatewayRefundId ?? null,
        }),
      );
    }
    if (outcome.status === 'FAILED') {
      const policy = await this.config.get('refundDestinationPolicy');
      const fallback =
        policy !== 'original' &&
        row.destination === 'GATEWAY' &&
        row.source_type === 'GATEWAY_CAPTURE';
      const destination: RefundDestination = fallback ? 'WALLET' : row.destination;
      const updated = await this.refunds.transition(
        tx,
        row.id,
        row.status,
        fallback ? 'PROCESSED' : 'FAILED',
        {
          destination,
          gatewayRefundId: outcome.gatewayRefundId ?? null,
        },
      );
      if (fallback)
        await appendEvent(tx, settledEvent(updated, await ownerOf(tx, updated.order_id)), [
          'wallet',
          'notifications',
          'invoicing',
        ]);
      else
        await recordFinding(tx, {
          kind: 'REFUND_FAILED_MANUAL',
          severity: 'WARN',
          aggregateType: 'payment_refund',
          aggregateId: row.id,
          reference: row.refund_reference,
          details: { policy },
        });
      return view(updated);
    }
    const updated = await this.refunds.transition(
      tx,
      row.id,
      row.status,
      outcome.status === 'PROCESSED' ? 'PROCESSED' : 'UNKNOWN',
      { gatewayRefundId: outcome.gatewayRefundId ?? null },
    );
    if (updated.status === 'PROCESSED')
      await appendEvent(tx, settledEvent(updated, await ownerOf(tx, updated.order_id)), [
        'wallet',
        'notifications',
        'invoicing',
      ]);
    return view(updated);
  }
  /** An operator records an already completed manual payment; no transfer occurs here. */
  async markManualRefundPaid(input: {
    refundReference: string;
    actorId: string;
    paymentReference: string;
    evidenceMediaId: string;
    idempotencyKey: string;
  }): Promise<RefundView> {
    if (
      !input.paymentReference.trim() ||
      input.paymentReference.length > 150 ||
      !input.idempotencyKey.trim() ||
      input.idempotencyKey.length > 150
    )
      throw new Error('INVALID_INPUT');
    const hash = createHash('sha256').update(JSON.stringify(input)).digest('hex');
    return transactionWithRetry(this.db, async (tx) => {
      const actor = await sql`SELECT u.id FROM users u JOIN user_roles r ON r.user_id=u.id
        WHERE u.id=${input.actorId}::uuid AND u.status='ACTIVE' AND u.pool='WORKFORCE'
        AND r.role IN ('SUPER_ADMIN') FOR SHARE OF u,r`.execute(tx);
      if (!actor.rows.length) throw new Error('FORBIDDEN');
      const row = await this.refunds.lockByReference(tx, input.refundReference);
      if (!row || row.destination !== 'MANUAL_PAYOUT') throw new Error('RESOURCE_NOT_FOUND');
      const prior = await sql<{
        request_hash: string;
      }>`SELECT request_hash FROM manual_refund_settlements
        WHERE refund_id=${row.id}::uuid`.execute(tx);
      if (prior.rows[0]) {
        if (prior.rows[0].request_hash !== hash) throw new Error('IDEMPOTENCY_KEY_REUSED');
        return view(row);
      }
      if (row.status !== 'PENDING') throw new Error('REFUND_STATE_INVALID');
      const evidence =
        await sql`SELECT id FROM private_media WHERE id=${input.evidenceMediaId}::uuid
        AND owner_id=${input.actorId}::uuid AND purpose='PAYOUT_EVIDENCE' AND state='STORED' FOR SHARE`.execute(
          tx,
        );
      if (!evidence.rows.length) throw new Error('MEDIA_NOT_FOUND');
      await sql`INSERT INTO manual_refund_settlements(refund_id,actor_id,payment_reference,evidence_media_id,idempotency_key,request_hash)
        VALUES(${row.id}::uuid,${input.actorId}::uuid,${input.paymentReference},${input.evidenceMediaId}::uuid,${input.idempotencyKey},${hash})`.execute(
        tx,
      );
      const processed = await this.refunds.transition(tx, row.id, 'PENDING', 'PROCESSED', {});
      await appendEvent(tx, settledEvent(processed, await ownerOf(tx, processed.order_id)), [
        'wallet',
        'notifications',
        'invoicing',
      ]);
      await sql`INSERT INTO audit_log(id,actor_id,action,subject_type,subject_id,details)
        VALUES(${uuidV7()}::uuid,${input.actorId}::uuid,'payments.manual_refund_paid','payment_refund',${row.id},${JSON.stringify({ paymentReference: input.paymentReference, evidenceMediaId: input.evidenceMediaId })}::jsonb)`.execute(
        tx,
      );
      return view(processed);
    });
  }
  /** Documented lookup path for a lost refund response. */
  async recoverUnknown(refundReference: string): Promise<RefundView> {
    const row = await this.refunds.byReference(refundReference);
    if (!row || row.status !== 'UNKNOWN' || row.destination !== 'GATEWAY') {
      if (!row) throw new Error('RESOURCE_NOT_FOUND');
      return view(row);
    }
    const found = await this.gateway
      .findRefundByReceipt(row.source_id, refundReference)
      .catch(() => null);
    if (!found) return view(row);
    return this.applyOutcome(refundReference, {
      status: found.status === 'UNKNOWN' ? 'PENDING' : found.status,
      gatewayRefundId: found.gatewayRefundId ?? undefined,
    });
  }
  async refundableCapacity(
    orderId: string,
    outer?: TransactionContext,
  ): Promise<readonly RefundSourceCapacity[]> {
    const run = async (tx: TransactionContext) =>
      (await this.refunds.capacity(tx, orderId)).map((row) => ({
        ...row,
        availablePaise: (BigInt(row.fundedPaise) - BigInt(row.committedPaise)).toString(),
      }));
    return outer ? run(outer) : transactionWithRetry(this.db, run);
  }
  async refundsForOrder(orderId: string): Promise<readonly RefundView[]> {
    return (await this.refunds.listByOrder(orderId)).map(view);
  }
}
function settledEvent(row: RefundRow, userId: string | null) {
  return {
    eventId: uuidV7(),
    eventType: 'payments.refund.settled',
    schemaVersion: 1,
    aggregateType: 'payment_refund',
    aggregateId: row.id,
    aggregateVersion: row.status === 'PENDING' ? '1' : '2',
    occurredAt: new Date().toISOString(),
    correlationId: row.refund_reference,
    causationId: null,
    payload: settledEventPayload(row, userId),
  } as const;
}
/** Wallet-facing refunds carry the owning user for the crediting consumer. */
async function ownerOf(tx: TransactionContext, orderId: string): Promise<string | null> {
  const owner = await sql<{
    user_id: string;
  }>`SELECT user_id FROM orders WHERE id=${orderId}::uuid`.execute(tx);
  return owner.rows[0]?.user_id ?? null;
}
