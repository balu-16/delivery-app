import { sql } from 'kysely';
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
import type {
  CreateAttemptInput,
  PaymentIntent,
  PaymentOrderOperations,
} from '../contracts/payments.js';
import { gatewayAmountPaise } from '../contracts/amounts.js';
import { newOperationReference, type OperationKind } from '../domain/references.js';
import { PostgresAttempts, type AttemptRow } from './postgres-attempts.js';
import type { DurableOperations } from './durable-ops.js';
import { recordFinding } from './findings.js';

function view(row: AttemptRow): PaymentIntent {
  return {
    attemptId: row.id,
    orderId: row.order_id ?? row.aggregate_id,
    operationReference: row.operation_reference,
    kind: row.kind as OperationKind,
    gatewayOrderId: row.gateway_order_id,
    gatewayPaymentId: row.gateway_payment_id,
    amountPaise: row.amount_paise,
    currency: row.currency,
    status: row.status,
    createdAt: row.created_at.toISOString(),
  };
}

/**
 * Durable gateway-order creation (D17/ADR 0007): the operation row and attempt
 * row commit before the external call; the call runs outside any transaction;
 * definitive rejections fail the attempt (retrying means a new durable
 * reference); ambiguous or unavailable outcomes recover through the documented
 * receipt lookup and never recreate the gateway order.
 */
export class PaymentOrderService implements PaymentOrderOperations {
  async recoverPendingBatch(limit: number): Promise<number> {
    const due = await sql<{
      operation_reference: string;
    }>`SELECT a.operation_reference FROM payment_attempts a JOIN durable_operations d ON d.reference=a.operation_reference
      WHERE a.gateway_order_id IS NULL AND a.status IN ('CREATED','UNKNOWN') AND d.state IN ('pending','unknown')
      AND a.external_attempts<12 AND d.updated_at<clock_timestamp()-interval '1 minute' ORDER BY d.updated_at LIMIT ${limit}`.execute(
      this.db,
    );
    for (const row of due.rows) {
      const attempt = await this.attempts.byOperationReference(row.operation_reference);
      if (!attempt) continue;
      await this.db
        .transaction()
        .execute((tx) => this.attempts.countExternalAttempt(tx, attempt.id));
      await this.completeSetup(row.operation_reference, row.operation_reference).catch(
        () => undefined,
      );
    }
    return due.rows.length;
  }
  constructor(
    private readonly db: Database,
    private readonly attempts: PostgresAttempts,
    private readonly durable: DurableOperations,
    private readonly gateway: PaymentGatewayPort,
    private readonly gatewayName: string,
  ) {}
  private run<T>(tx: TransactionContext | undefined, fn: (tx: TransactionContext) => Promise<T>) {
    return tx ? fn(tx) : transactionWithRetry(this.db, fn);
  }
  async createAttempt(input: CreateAttemptInput): Promise<PaymentIntent> {
    gatewayAmountPaise(input.amountPaise);
    if (!/^[A-Z]{3}$/.test(input.currency)) throw new Error('INVALID_INPUT');
    const operationReference =
      input.operationReference ??
      newOperationReference(input.kind === 'WALLET_TOPUP' ? 'topup' : 'order');
    const row = await this.run(input.tx, async (tx) => {
      await this.durable.create(tx, 'PAYMENT_ORDER_CREATE', operationReference, {
        aggregateId: input.aggregateId,
        kind: input.kind,
        amountPaise: input.amountPaise,
        currency: input.currency,
      });
      return this.attempts.insert(tx, {
        aggregateId: input.aggregateId,
        kind: input.kind,
        orderId: input.kind === 'ORDER_PAYMENT' ? input.aggregateId : null,
        userId: input.userId ?? null,
        operationReference,
        gateway: this.gatewayName,
        amountPaise: input.amountPaise,
        currency: input.currency,
      });
    });
    if (input.tx) return view(row); // joined transactions complete the operation themselves
    await this.completeCreate(row, input.receipt ?? operationReference);
    return view((await this.attempts.byId(row.id)) ?? row);
  }
  /** External create plus outcome recording; never runs inside a DB transaction. */
  async completeCreate(row: AttemptRow, _receipt: string): Promise<void> {
    // Claim before contacting the provider. A crash or ambiguous response leaves
    // UNKNOWN, which is resolved only by receipt lookup, never another create.
    const claim = await sql<{
      reference: string;
    }>`UPDATE durable_operations SET state='unknown',updated_at=clock_timestamp()
      WHERE reference=${row.operation_reference} AND state='pending' RETURNING reference`.execute(
      this.db,
    );
    if (!claim.rows.length) {
      await this.recoverPendingOperation(row.operation_reference);
      return;
    }
    try {
      const result = await this.gateway.createOrder({
        operationReference: row.operation_reference,
        amountPaise: row.amount_paise,
        currency: row.currency,
        receipt: row.operation_reference,
      });
      await transactionWithRetry(this.db, async (tx) => {
        await this.attempts.setGatewayOrderId(tx, row.id, result.gatewayOrderId);
        await this.attempts.countExternalAttempt(tx, row.id);
        await this.durable.complete(row.operation_reference, {
          gatewayOrderId: result.gatewayOrderId,
        });
      });
    } catch (error: unknown) {
      const ambiguous = isGatewayAmbiguous(error) || error instanceof GatewayUnavailableError;
      if (!ambiguous && !(error instanceof GatewayRejectedError)) throw error;
      if (ambiguous) {
        await this.recoverPendingOperation(row.operation_reference);
        return;
      }
      await transactionWithRetry(this.db, async (tx) => {
        await this.attempts.transition(tx, row.id, row.status, 'FAILED', {
          failureCode: 'GATEWAY_REJECTED',
        });
        await this.attempts.countExternalAttempt(tx, row.id);
        await this.durable.complete(row.operation_reference, { rejected: true });
      });
    }
  }
  /**
   * Post-commit gateway setup (plan 5.2): re-drives the external create for
   * a durable attempt; never recreates an order that already has a gateway
   * id; a definitively rejected attempt keeps its FAILED state (retries use a
   * new attempt via the retry endpoint).
   */
  async completeSetup(operationReference: string, receipt: string): Promise<PaymentIntent> {
    const row = await this.attempts.byOperationReference(operationReference);
    if (!row) throw new Error('PAYMENT_NOT_FOUND');
    if (!row.gateway_order_id && row.status === 'CREATED') await this.completeCreate(row, receipt);
    else if (row.status === 'UNKNOWN') await this.recoverPendingOperation(operationReference);
    return view((await this.attempts.byId(row.id)) ?? row);
  }
  /** Bounded documented lookup: exactly one amount/currency match is adopted. */
  async recoverPendingOperation(operationReference: string): Promise<PaymentIntent | null> {
    const operation = await this.durable.pending(operationReference);
    const row = await this.attempts.byOperationReference(operationReference);
    if (!operation || !row || operation.state === 'done') return null;
    const distinct = await this.lookupByReceipt(row).catch(() => null);
    if (distinct !== null) {
      await transactionWithRetry(this.db, async (tx) => {
        await this.attempts.setGatewayOrderId(tx, row.id, distinct);
        await this.attempts.countExternalAttempt(tx, row.id);
        await this.durable.complete(operationReference, { gatewayOrderId: distinct });
      });
      return view((await this.attempts.byId(row.id)) ?? row);
    }
    await transactionWithRetry(this.db, async (tx) => {
      await this.attempts.countExternalAttempt(tx, row.id);
      await this.durable.markUnknown(operationReference, { reason: 'LOST_CREATE_RESPONSE' });
      await recordFinding(tx, {
        kind: 'GATEWAY_OPERATION_UNKNOWN',
        severity: 'WARN',
        aggregateType: 'payment_attempt',
        aggregateId: row.id,
        reference: operationReference,
        details: { reason: 'lost create response; receipt lookup inconclusive' },
      });
    });
    return null;
  }
  private async lookupByReceipt(row: AttemptRow): Promise<string | null> {
    const matches = await this.gateway.findOrdersByReceipt(row.operation_reference);
    const amount = gatewayAmountPaise(row.amount_paise);
    const distinct = [
      ...new Set(
        matches
          .filter(
            (order) =>
              BigInt(order.amountPaise) === amount &&
              order.currency === row.currency &&
              ['created', 'attempted', 'paid'].includes(order.status),
          )
          .map((order) => order.gatewayOrderId),
      ),
    ];
    if (distinct.length !== 1) throw new Error('GATEWAY_OPERATION_UNRESOLVED');
    return distinct[0]!;
  }
  async intentByOperationReference(operationReference: string): Promise<PaymentIntent | null> {
    const row = await this.attempts.byOperationReference(operationReference);
    return row ? view(row) : null;
  }
  async listAttempts(aggregateId: string): Promise<readonly PaymentIntent[]> {
    return (await this.attempts.listByAggregate(aggregateId)).map(view);
  }
}
