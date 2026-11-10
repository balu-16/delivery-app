import { sql } from 'kysely';
import { uuidV7 } from '../../../common/ids/ids.js';
import type { Database, Json, TransactionContext } from '../../../platform/database/database.js';
import { appendEvent } from '../../../platform/outbox/outbox.js';

/** Findings and signals accept a transaction or the plain database handle. */
type Executor = Database | TransactionContext;

/**
 * Admin-visible findings (Section 28 business alerts; PAY-03/ADD-13). Open
 * findings dedupe per (kind, reference) so retries never flood the review
 * queue. Findings never apply money effects by themselves.
 */
export async function recordFinding(
  tx: Executor,
  input: {
    kind: string;
    severity: 'WARN' | 'CRITICAL';
    aggregateType: string;
    aggregateId: string;
    reference: string;
    details: Json;
  },
): Promise<void> {
  if (!tx.isTransaction) return tx.transaction().execute((ctx) => recordFinding(ctx, input));
  const inserted = await sql<{
    id: string;
  }>`INSERT INTO reconciliation_findings(id,kind,severity,aggregate_type,aggregate_id,reference,details)
    VALUES (${uuidV7()}::uuid,${input.kind},${input.severity},${input.aggregateType},${input.aggregateId},${input.reference},${JSON.stringify(input.details)}::jsonb)
    ON CONFLICT (kind,reference) WHERE status='OPEN' DO NOTHING RETURNING id`.execute(tx);
  if (inserted.rows[0])
    await appendEvent(
      tx as TransactionContext,
      {
        eventId: uuidV7(),
        eventType: 'reconciliation.finding',
        schemaVersion: 1,
        aggregateType: 'reconciliation_finding',
        aggregateId: inserted.rows[0].id,
        aggregateVersion: '1',
        occurredAt: new Date().toISOString(),
        correlationId: input.reference,
        causationId: null,
        payload: {
          kind: input.kind,
          aggregateType: input.aggregateType,
          aggregateId: input.aggregateId,
          severity: input.severity,
        },
      },
      ['notifications'],
    );
}

/** Fraud signals are advisory (D25): they surface to admins and never block. */
export async function recordFraudSignal(
  tx: Executor,
  input: {
    userId: string | null;
    kind: string;
    severity: 'WARN' | 'CRITICAL';
    reference: string;
    details: Json;
  },
): Promise<void> {
  if (!tx.isTransaction) return tx.transaction().execute((ctx) => recordFraudSignal(ctx, input));
  await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`fraud:${input.kind}:${input.reference}`},0))`.execute(
    tx,
  );
  const old =
    await sql`SELECT id FROM fraud_signals WHERE kind=${input.kind} AND reference=${input.reference} AND status='OPEN'`.execute(
      tx,
    );
  if (old.rows.length) return;
  const id = uuidV7();
  await sql`INSERT INTO fraud_signals(id,user_id,kind,severity,reference,details)
    VALUES (${id}::uuid,${input.userId}::uuid,${input.kind},${input.severity},${input.reference},${JSON.stringify(input.details)}::jsonb)`.execute(
    tx,
  );
  await appendEvent(
    tx as TransactionContext,
    {
      eventId: uuidV7(),
      eventType: 'ops.anomaly',
      schemaVersion: 1,
      aggregateType: 'fraud_signal',
      aggregateId: id,
      aggregateVersion: '1',
      occurredAt: new Date().toISOString(),
      correlationId: input.reference,
      causationId: null,
      payload: {
        kind: input.kind,
        severity: input.severity,
        userId: input.userId,
        detail: input.kind,
      },
    },
    ['notifications'],
  );
}
