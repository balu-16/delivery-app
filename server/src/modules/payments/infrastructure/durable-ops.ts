import { sql } from 'kysely';
import { uuidV7 } from '../../../common/ids/ids.js';
import type { Database, Json, TransactionContext } from '../../../platform/database/database.js';

/**
 * Durable operation records (plan 5.2/D17): every create/refund persists its
 * stable correlation reference BEFORE the external call; the call itself runs
 * outside any DB transaction; outcomes are recorded afterwards. States are
 * `pending -> done | unknown`; `unknown` routes to reconciliation instead of a
 * speculative retry that could duplicate a financial effect.
 */
export type DurableOperationState = 'pending' | 'done' | 'unknown';
export interface DurableOperations {
  create(tx: TransactionContext, kind: string, reference: string, payload: Json): Promise<void>;
  /** Returns false when the reference already exists (idempotent recreation). */
  createOnce(
    tx: TransactionContext,
    kind: string,
    reference: string,
    payload: Json,
  ): Promise<boolean>;
  complete(reference: string, payload: Json): Promise<void>;
  markUnknown(reference: string, payload: Json): Promise<void>;
  pending(reference: string): Promise<{ state: DurableOperationState; payload: Json } | null>;
}
export class PostgresDurableOperations implements DurableOperations {
  constructor(private readonly db: Database) {}
  async create(
    tx: TransactionContext,
    kind: string,
    reference: string,
    payload: Json,
  ): Promise<void> {
    await sql`INSERT INTO durable_operations(id,kind,reference,state,payload)
      VALUES (${uuidV7()}::uuid,${kind},${reference},'pending',${JSON.stringify(payload)}::jsonb)`.execute(
      tx,
    );
  }
  async createOnce(
    tx: TransactionContext,
    kind: string,
    reference: string,
    payload: Json,
  ): Promise<boolean> {
    const inserted = await sql<{
      id: string;
    }>`INSERT INTO durable_operations(id,kind,reference,state,payload)
      VALUES (${uuidV7()}::uuid,${kind},${reference},'pending',${JSON.stringify(payload)}::jsonb)
      ON CONFLICT (kind,reference) DO NOTHING RETURNING id`.execute(tx);
    return inserted.rows.length > 0;
  }
  async complete(reference: string, payload: Json): Promise<void> {
    await this.finish(reference, 'done', payload);
  }
  async markUnknown(reference: string, payload: Json): Promise<void> {
    await this.finish(reference, 'unknown', payload);
  }
  private async finish(
    reference: string,
    state: DurableOperationState,
    payload: Json,
  ): Promise<void> {
    await this.db.transaction().execute(async (tx) => {
      await sql`UPDATE durable_operations SET state=${state},payload=${JSON.stringify(payload)}::jsonb,updated_at=clock_timestamp()
        WHERE reference=${reference} AND state IN ('pending','unknown')`.execute(tx);
    });
  }
  async pending(
    reference: string,
  ): Promise<{ state: DurableOperationState; payload: Json } | null> {
    const result = await sql<{
      state: string;
      payload: Json;
    }>`SELECT state,payload FROM durable_operations
      WHERE reference=${reference}`.execute(this.db);
    const row = result.rows[0];
    if (!row) return null;
    return { state: row.state as DurableOperationState, payload: row.payload };
  }
}
