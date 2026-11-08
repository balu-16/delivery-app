import { sql, type RawBuilder } from 'kysely';
import { uuidV7 } from '../../../common/ids/ids.js';
import { gatewayAmountPaise } from '../contracts/amounts.js';
import type { AttemptState } from '../contracts/payments.js';
import { transitionAttempt } from '../domain/states.js';
import { validReference } from '../domain/references.js';
import type { Database, TransactionContext } from '../../../platform/database/database.js';

export interface AttemptRow {
  id: string;
  aggregate_id: string;
  kind: string;
  order_id: string | null;
  user_id: string | null;
  operation_reference: string;
  gateway: string;
  gateway_order_id: string | null;
  gateway_payment_id: string | null;
  amount_paise: string;
  currency: string;
  status: AttemptState;
  failure_code: string | null;
  captured_at: Date | null;
  external_attempts: number;
  created_at: Date;
  updated_at: Date;
}
const FIELDS =
  'id,aggregate_id,kind,order_id,user_id,operation_reference,gateway,gateway_order_id,gateway_payment_id,amount_paise::text AS amount_paise,currency,status,failure_code,captured_at,external_attempts,created_at,updated_at';

function select(where: RawBuilder<unknown>): RawBuilder<AttemptRow> {
  return sql<AttemptRow>`SELECT ${sql.raw(FIELDS)} FROM payment_attempts ${where}`;
}

/**
 * Payment attempts are modelled separately from order funding (D18). One
 * aggregate may hold several attempts; captures fund at most once and stale
 * failures can never regress a capture (state machine in domain/states.ts).
 */
export class PostgresAttempts {
  constructor(private readonly db: Database) {}
  async insert(
    tx: TransactionContext,
    input: {
      aggregateId: string;
      kind: string;
      orderId: string | null;
      userId: string | null;
      operationReference: string;
      gateway: string;
      amountPaise: string;
      currency: string;
    },
  ): Promise<AttemptRow> {
    if (!validReference(input.operationReference)) throw new Error('INVALID_INPUT');
    gatewayAmountPaise(input.amountPaise);
    if (!/^[A-Z]{3}$/.test(input.currency)) throw new Error('INVALID_INPUT');
    const inserted = await sql<AttemptRow>`INSERT INTO payment_attempts
      (id,aggregate_id,kind,order_id,user_id,operation_reference,gateway,amount_paise,currency)
      VALUES (${uuidV7()}::uuid,${input.aggregateId}::uuid,${input.kind},${input.orderId}::uuid,${input.userId}::uuid,
        ${input.operationReference},${input.gateway},${input.amountPaise}::bigint,${input.currency})
      RETURNING ${sql.raw(FIELDS)}`.execute(tx);
    return inserted.rows[0]!;
  }
  async byOperationReference(reference: string): Promise<AttemptRow | null> {
    const result = await select(sql`WHERE operation_reference=${reference}`).execute(this.db);
    return result.rows[0] ?? null;
  }
  async byGatewayOrderId(gatewayOrderId: string): Promise<AttemptRow | null> {
    const result = await select(sql`WHERE gateway_order_id=${gatewayOrderId}`).execute(this.db);
    return result.rows[0] ?? null;
  }
  async byId(id: string): Promise<AttemptRow | null> {
    const result = await select(sql`WHERE id=${id}::uuid`).execute(this.db);
    return result.rows[0] ?? null;
  }
  async listByAggregate(aggregateId: string): Promise<readonly AttemptRow[]> {
    const result = await select(
      sql`WHERE aggregate_id=${aggregateId}::uuid ORDER BY created_at,id`,
    ).execute(this.db);
    return result.rows;
  }
  /** Row lock for webhook correlation and state transitions (lock order: attempt before wallet). */
  async lockById(tx: TransactionContext, id: string): Promise<AttemptRow | null> {
    const result = await select(sql`WHERE id=${id}::uuid FOR UPDATE`).execute(tx);
    return result.rows[0] ?? null;
  }
  async transition(
    tx: TransactionContext,
    id: string,
    current: AttemptState,
    next: AttemptState,
    patch: {
      gatewayOrderId?: string | null;
      gatewayPaymentId?: string | null;
      failureCode?: string | null;
    },
  ): Promise<AttemptRow> {
    const checked = transitionAttempt(current, next);
    const updated = await sql<AttemptRow>`UPDATE payment_attempts SET
      status=${checked},updated_at=clock_timestamp(),
      gateway_order_id=COALESCE(${patch.gatewayOrderId ?? null},gateway_order_id),
      gateway_payment_id=COALESCE(${patch.gatewayPaymentId ?? null},gateway_payment_id),
      failure_code=${patch.failureCode ?? null},
      captured_at=CASE WHEN ${checked}='CAPTURED' THEN clock_timestamp() ELSE captured_at END
      WHERE id=${id}::uuid AND status=${current} RETURNING ${sql.raw(FIELDS)}`.execute(tx);
    if (!updated.rows[0]) throw new Error('PAYMENT_STATE_INVALID');
    return updated.rows[0];
  }
  async setGatewayOrderId(
    tx: TransactionContext,
    id: string,
    gatewayOrderId: string | null,
  ): Promise<void> {
    await sql`UPDATE payment_attempts SET gateway_order_id=${gatewayOrderId},updated_at=clock_timestamp()
      WHERE id=${id}::uuid`.execute(tx);
  }
  async countExternalAttempt(tx: TransactionContext, id: string): Promise<void> {
    await sql`UPDATE payment_attempts SET external_attempts=external_attempts+1,updated_at=clock_timestamp()
      WHERE id=${id}::uuid`.execute(tx);
  }
}
