import { sql } from 'kysely';
import { type Database, type TransactionContext } from '../database/database.js';

/** Dedupe and effect commit together; handler must not call external services. */
export async function consumeOnce(
  db: Database,
  eventId: string,
  consumer: string,
  effect: (tx: TransactionContext) => Promise<void>,
): Promise<boolean> {
  return db.transaction().execute(async (tx) => {
    const delivery = await sql<{
      completed_at: Date | null;
      suspended_at: Date | null;
    }>`SELECT completed_at,suspended_at FROM outbox_deliveries WHERE event_id=${eventId}::uuid AND consumer=${consumer} FOR UPDATE`.execute(
      tx,
    );
    const row = delivery.rows[0];
    if (!row) throw new Error('DELIVERY_NOT_FOUND');
    if (row.completed_at || row.suspended_at) return false;
    const inserted =
      await sql`INSERT INTO processed_events(consumer,event_id) VALUES (${consumer},${eventId}::uuid) ON CONFLICT DO NOTHING RETURNING event_id`.execute(
        tx,
      );
    if (inserted.rows.length) await effect(tx);
    await sql`UPDATE outbox_deliveries SET completed_at=clock_timestamp(),lease_token=NULL,lease_until=NULL,last_error=NULL WHERE event_id=${eventId}::uuid AND consumer=${consumer}`.execute(
      tx,
    );
    return inserted.rows.length > 0;
  });
}

/** Record failed attempts after rollback; successful effects and completion share one row lock. */
export async function failDeliveryAttempt(
  db: Database,
  eventId: string,
  consumer: string,
  maxAttempts: number,
): Promise<void> {
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 100)
    throw new Error('INVALID_ATTEMPT_LIMIT');
  await sql`UPDATE outbox_deliveries SET processing_attempts=processing_attempts+1,
    suspended_at=CASE WHEN processing_attempts+1 >= ${maxAttempts} THEN clock_timestamp() ELSE NULL END,
    next_publish_at=clock_timestamp() + (LEAST(300, power(2, LEAST(processing_attempts+1, 8))) + random()) * interval '1 second',
    last_error='handler failed'
    WHERE event_id=${eventId}::uuid AND consumer=${consumer} AND completed_at IS NULL AND suspended_at IS NULL`.execute(
    db,
  );
}
