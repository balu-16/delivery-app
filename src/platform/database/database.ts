import { Kysely, PostgresDialect, sql, type Generated, type Transaction } from 'kysely';
import { Pool } from 'pg';

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export interface PlatformSchema {
  durable_operations: {
    id: string;
    kind: string;
    reference: string;
    state: string;
    payload: Json;
    created_at: Generated<Date>;
    updated_at: Generated<Date>;
  };
  idempotency_keys: {
    actor: string;
    audience: string;
    method: string;
    resource: string;
    key: string;
    request_hash: string;
    operation_id: string;
    state: 'PROCESSING' | 'COMPLETED';
    owner_token: string | null;
    lease_until: Date | null;
    response_status: number | null;
    response_body: Json;
    response_expires_at: Date | null;
    created_at: Generated<Date>;
    updated_at: Generated<Date>;
  };
  outbox_events: {
    id: string;
    event_type: string;
    schema_version: number;
    aggregate_type: string;
    aggregate_id: string;
    aggregate_version: string;
    occurred_at: Generated<Date>;
    correlation_id: string;
    causation_id: string | null;
    payload: Json;
  };
  outbox_deliveries: {
    event_id: string;
    consumer: string;
    lease_token: string | null;
    lease_until: Date | null;
    next_publish_at: Generated<Date>;
    publish_attempts: Generated<number>;
    processing_attempts: Generated<number>;
    suspended_at: Date | null;
    last_enqueued_at: Date | null;
    completed_at: Date | null;
    last_error: string | null;
  };
  processed_events: { consumer: string; event_id: string; processed_at: Generated<Date> };
}
export type Database = Kysely<PlatformSchema>;
export type TransactionContext = Transaction<PlatformSchema>;
export interface DatabaseHandle {
  db: Database;
  ping(): Promise<void>;
  close(): Promise<void>;
}

/** Owns a pool. Application composition owns the lifetime. */
export function createDatabase(
  connectionString: string,
  poolMax = 20,
  statementTimeoutMs = 10000,
  onIdleError: () => void = () => {
    process.stderr.write('{"level":"error","msg":"Idle database connection failed"}\n');
  },
): DatabaseHandle {
  if (
    !connectionString ||
    !Number.isSafeInteger(poolMax) ||
    poolMax < 1 ||
    !Number.isSafeInteger(statementTimeoutMs) ||
    statementTimeoutMs < 1
  )
    throw new Error('Invalid database configuration');
  const pool = new Pool({ connectionString, max: poolMax, statement_timeout: statementTimeoutMs });
  // pg removes failed idle clients; the next checkout opens a fresh connection.
  // Do not include the driver's error, which can contain connection details.
  pool.on('error', () => onIdleError());
  const db = new Kysely<PlatformSchema>({ dialect: new PostgresDialect({ pool }) });
  return {
    db,
    async ping() {
      await sql`SELECT 1`.execute(db);
    },
    async close() {
      await db.destroy();
    },
  };
}

/** Call after taking relevant row locks: PostgreSQL transaction_timestamp() is too old after a wait. */
export async function databaseTimeAfterLock(tx: TransactionContext): Promise<Date> {
  const result = await sql<{ now: Date }>`SELECT clock_timestamp() AS now`.execute(tx);
  const row = result.rows[0];
  if (!row) throw new Error('Database clock returned no row');
  return row.now;
}

/** Retry only database rollback errors; callback must not perform external side effects. */
export async function transactionWithRetry<T>(
  db: Database,
  work: (tx: TransactionContext) => Promise<T>,
  maxAttempts = 3,
): Promise<T> {
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10)
    throw new Error('Invalid retry bound');
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await db.transaction().execute(work);
    } catch (error: unknown) {
      const code =
        typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : '';
      if (attempt >= maxAttempts || (code !== '40001' && code !== '40P01')) throw error;
      await new Promise<void>((resolve) =>
        setTimeout(resolve, Math.floor(Math.random() * 15 * attempt)),
      );
    }
  }
}

export function requireExpectedVersion(actual: number, expected: number): void {
  if (actual !== expected) throw new Error('CONCURRENT_MODIFICATION');
}
