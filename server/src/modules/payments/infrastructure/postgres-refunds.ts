import { sql } from 'kysely';
import { uuidV7 } from '../../../common/ids/ids.js';
import type { Database, TransactionContext } from '../../../platform/database/database.js';
import { nonNegativeAmountPaise } from '../contracts/amounts.js';
import { transitionRefund } from '../domain/states.js';
import type { RefundDestination, RefundSourceType, RefundState } from '../contracts/payments.js';

export interface RefundRow {
  id: string;
  order_id: string;
  refund_reference: string;
  source_type: RefundSourceType;
  source_id: string;
  attempt_id: string | null;
  amount_paise: string;
  destination: RefundDestination;
  status: RefundState;
  gateway_refund_id: string | null;
  reason: string | null;
  initiated_by: string | null;
  external_attempts: number;
}
const COLUMNS =
  'id,order_id,refund_reference,source_type,source_id,attempt_id,amount_paise::text AS amount_paise,destination,status,gateway_refund_id,reason,initiated_by,external_attempts';
type Row = {
  id: string;
  order_id: string;
  refund_reference: string;
  source_type: RefundSourceType;
  source_id: string;
  attempt_id: string | null;
  amount_paise: string;
  destination: RefundDestination;
  status: RefundState;
  gateway_refund_id: string | null;
  reason: string | null;
  initiated_by: string | null;
  external_attempts: number;
};

function map(row: Record<string, unknown>): RefundRow {
  return row as unknown as Row;
}
/**
 * Funding per paid source (ADR 0008): gateway captures, net wallet debits and
 * verified COD collections each reserve their own refundable capacity.
 */
async function fundedForSource(
  tx: TransactionContext,
  sourceType: RefundSourceType,
  sourceId: string,
  orderId: string,
): Promise<bigint> {
  if (sourceType === 'GATEWAY_CAPTURE') {
    const result = await sql<{
      total: string | null;
    }>`SELECT COALESCE(SUM(amount_paise),0)::text AS total
      FROM (
        SELECT amount_paise FROM payment_capture_receipts WHERE gateway_payment_id=${sourceId} AND order_id=${orderId}::uuid
        UNION ALL SELECT amount_paise FROM payment_attempts a WHERE gateway_payment_id=${sourceId} AND order_id=${orderId}::uuid
          AND status='CAPTURED' AND NOT EXISTS(SELECT 1 FROM payment_capture_receipts c WHERE c.gateway_payment_id=a.gateway_payment_id)
      ) funding`.execute(tx);
    return BigInt(result.rows[0]!.total ?? '0');
  }
  if (sourceType === 'WALLET_DEBIT') {
    const result = await sql<{
      promo: string;
      cash: string;
    }>`SELECT promo_paise::text AS promo,cash_paise::text AS cash
      FROM wallet_funding_allocations WHERE wallet_spend_reference=${sourceId} AND order_id=${orderId}::uuid`.execute(
      tx,
    );
    const row = result.rows[0];
    if (!row) return 0n;
    const restored = await sql<{
      amount: string;
    }>`SELECT COALESCE(sum(w.amount_paise),0)::text AS amount
      FROM wallet_reversal_allocations w WHERE w.spend_reference=${sourceId}
        AND NOT EXISTS(SELECT 1 FROM payment_refunds r JOIN refund_allocations a ON a.refund_id=r.id
          WHERE r.id::text=w.reversal_reference AND a.source_type='WALLET_DEBIT' AND a.source_id=${sourceId}
            AND r.status IN ('PENDING','PROCESSED','UNKNOWN'))`.execute(tx);
    return BigInt(row.promo) + BigInt(row.cash) - BigInt(restored.rows[0]!.amount);
  }
  const result = await sql<{
    total: string | null;
  }>`SELECT COALESCE(SUM(amount_paise),0)::text AS total
    FROM cod_collections WHERE id=${sourceId}::uuid AND order_id=${orderId}::uuid AND state='COLLECTED'`.execute(
    tx,
  );
  return BigInt(result.rows[0]!.total ?? '0');
}

/** Pending plus processed plus unknown commitments reserve the source cap. */
async function committedForSource(
  tx: TransactionContext,
  sourceType: RefundSourceType,
  sourceId: string,
): Promise<bigint> {
  const result = await sql<{
    total: string | null;
  }>`SELECT COALESCE(SUM(a.amount_paise),0)::text AS total
    FROM refund_allocations a JOIN payment_refunds r ON r.id=a.refund_id
    WHERE a.source_type=${sourceType} AND a.source_id=${sourceId}
      AND r.status IN ('PENDING','PROCESSED','UNKNOWN')`.execute(tx);
  return BigInt(result.rows[0]!.total ?? '0');
}

export class PostgresRefunds {
  constructor(private readonly db: Database) {}

  /**
   * Commits a refund under a lock on the order row (lock order: order ->
   * attempt -> wallet), inserts the durable commitment and one allocation per
   * source, and returns the row; the caller performs any external call after
   * the transaction commits. Exceeding the reserved capacity is rejected.
   */
  async commit(
    tx: TransactionContext,
    input: {
      orderId: string;
      refundReference: string;
      sourceType: RefundSourceType;
      sourceId: string;
      attemptId: string | null;
      amountPaise: string;
      destination: RefundDestination;
      reason: string | null;
      initiatedBy: string | null;
    },
  ): Promise<RefundRow> {
    const amount = nonNegativeAmountPaise(input.amountPaise);
    if (amount <= 0n) throw new Error('INVALID_MONEY');
    await sql`SELECT id FROM orders WHERE id=${input.orderId}::uuid FOR UPDATE`.execute(tx);
    const funded = await fundedForSource(tx, input.sourceType, input.sourceId, input.orderId);
    const committed = await committedForSource(tx, input.sourceType, input.sourceId);
    if (funded - committed < amount) throw new Error('REFUND_LIMIT_EXCEEDED');
    const inserted = await sql<Record<string, unknown>>`INSERT INTO payment_refunds
      (id,order_id,refund_reference,source_type,source_id,attempt_id,amount_paise,destination,status,reason,initiated_by)
      VALUES (${uuidV7()}::uuid,${input.orderId}::uuid,${input.refundReference},${input.sourceType},${input.sourceId},
        ${input.attemptId}::uuid,${amount.toString()}::bigint,${input.destination},'PENDING',${input.reason},${input.initiatedBy}::uuid)
      RETURNING ${sql.raw(COLUMNS)}`.execute(tx);
    const row = map(inserted.rows[0]!);
    await sql`INSERT INTO refund_allocations(id,refund_id,source_type,source_id,amount_paise)
      VALUES (${uuidV7()}::uuid,${row.id}::uuid,${input.sourceType},${input.sourceId},${amount.toString()}::bigint)`.execute(
      tx,
    );
    return row;
  }

  async byReference(reference: string): Promise<RefundRow | null> {
    const result = await sql<
      Record<string, unknown>
    >`SELECT ${sql.raw(COLUMNS)} FROM payment_refunds WHERE refund_reference=${reference}`.execute(
      this.db,
    );
    return result.rows[0] ? map(result.rows[0]) : null;
  }
  async byId(id: string): Promise<RefundRow | null> {
    const result = await sql<
      Record<string, unknown>
    >`SELECT ${sql.raw(COLUMNS)} FROM payment_refunds WHERE id=${id}::uuid`.execute(this.db);
    return result.rows[0] ? map(result.rows[0]) : null;
  }
  async listByOrder(orderId: string): Promise<readonly RefundRow[]> {
    const result = await sql<
      Record<string, unknown>
    >`SELECT ${sql.raw(COLUMNS)} FROM payment_refunds WHERE order_id=${orderId}::uuid ORDER BY created_at,id`.execute(
      this.db,
    );
    return result.rows.map(map);
  }
  async lockByReference(tx: TransactionContext, reference: string): Promise<RefundRow | null> {
    const result = await sql<
      Record<string, unknown>
    >`SELECT ${sql.raw(COLUMNS)} FROM payment_refunds WHERE refund_reference=${reference} FOR UPDATE`.execute(
      tx,
    );
    return result.rows[0] ? map(result.rows[0]) : null;
  }

  /** Terminal transitions commit in the caller's transaction with their events. */
  async transition(
    tx: TransactionContext,
    id: string,
    current: RefundState,
    next: RefundState,
    patch: { gatewayRefundId?: string | null; destination?: RefundDestination },
  ): Promise<RefundRow> {
    const checked = transitionRefund(current, next);
    const updated = await sql<Record<string, unknown>>`UPDATE payment_refunds SET
      status=${checked},updated_at=clock_timestamp(),
      gateway_refund_id=COALESCE(${patch.gatewayRefundId ?? null},gateway_refund_id),
      destination=COALESCE(${patch.destination ?? null},destination),
      external_attempts=external_attempts+1
      WHERE id=${id}::uuid AND status=${current} RETURNING ${sql.raw(COLUMNS)}`.execute(tx);
    if (!updated.rows[0]) throw new Error('REFUND_STATE_INVALID');
    return map(updated.rows[0]);
  }

  async capacity(
    tx: TransactionContext,
    orderId: string,
  ): Promise<
    readonly {
      sourceType: RefundSourceType;
      sourceId: string;
      fundedPaise: string;
      committedPaise: string;
    }[]
  > {
    const sources: Array<{ sourceType: RefundSourceType; sourceId: string }> = [];
    const captures = await sql<{
      gateway_payment_id: string;
    }>`SELECT gateway_payment_id FROM payment_capture_receipts WHERE order_id=${orderId}::uuid
       UNION SELECT gateway_payment_id FROM payment_attempts WHERE order_id=${orderId}::uuid AND status='CAPTURED' AND gateway_payment_id IS NOT NULL`.execute(
      tx,
    );
    for (const row of captures.rows)
      sources.push({ sourceType: 'GATEWAY_CAPTURE', sourceId: row.gateway_payment_id });
    const wallet = await sql<{
      wallet_spend_reference: string;
    }>`SELECT wallet_spend_reference FROM wallet_funding_allocations
      WHERE order_id=${orderId}::uuid AND wallet_spend_reference IS NOT NULL`.execute(tx);
    for (const row of wallet.rows)
      sources.push({ sourceType: 'WALLET_DEBIT', sourceId: row.wallet_spend_reference });
    const cod = await sql<{ id: string }>`SELECT id FROM cod_collections
      WHERE order_id=${orderId}::uuid AND state='COLLECTED'`.execute(tx);
    for (const row of cod.rows) sources.push({ sourceType: 'COD_COLLECTION', sourceId: row.id });
    const capacity = [];
    for (const source of sources) {
      const funded = await fundedForSource(tx, source.sourceType, source.sourceId, orderId);
      const committed = await committedForSource(tx, source.sourceType, source.sourceId);
      capacity.push({
        ...source,
        fundedPaise: funded.toString(),
        committedPaise: committed.toString(),
      });
    }
    return capacity;
  }
}
