import { sql, type Kysely } from 'kysely';
import { uuidV7 } from '../../../common/ids/ids.js';
import type { PlatformSchema, TransactionContext } from '../../../platform/database/database.js';
import type { StoreSignals } from '../contracts/signals.js';

export class PostgresStoreSignals implements StoreSignals {
  constructor(
    private readonly db: Kysely<PlatformSchema>,
    private readonly settings: (
      tx?: TransactionContext,
    ) => Promise<{ backlog: number; minutes: number }>,
  ) {}
  async noRiders(storeId: string, at: Date, tx?: TransactionContext): Promise<boolean> {
    const { minutes } = await this.settings(tx);
    const result = await sql<{
      unavailable: boolean;
    }>`SELECT (no_riders_since IS NOT NULL AND no_riders_since + ${minutes} * interval '1 minute' <= ${at}::timestamptz) AS unavailable FROM store_operational_signals WHERE store_id=${storeId}`.execute(
      tx ?? this.db,
    );
    return result.rows[0]?.unavailable ?? false;
  }
  async observe(
    storeId: string,
    pickBacklog: number,
    ridersAvailable: boolean,
    correlationId: string,
  ): Promise<void> {
    const { backlog, minutes } = await this.settings();
    if (
      !Number.isSafeInteger(pickBacklog) ||
      pickBacklog < 0 ||
      !Number.isSafeInteger(backlog) ||
      backlog < 1 ||
      !Number.isSafeInteger(minutes) ||
      minutes < 1
    )
      throw new Error('INVALID_STORE_SIGNAL');
    await this.db.transaction().execute(async (tx) => {
      const store = await sql<{
        status: string;
      }>`SELECT status FROM stores WHERE id=${storeId} FOR UPDATE`.execute(tx);
      if (!store.rows[0]) throw new Error('STORE_NOT_FOUND');
      const result = await sql<{
        no_riders_since: Date | null;
        observed_at: Date;
      }>`INSERT INTO store_operational_signals(store_id,pick_backlog,no_riders_since,observed_at)
        VALUES (${storeId},${pickBacklog},CASE WHEN ${ridersAvailable} THEN NULL ELSE clock_timestamp() END,clock_timestamp())
        ON CONFLICT(store_id) DO UPDATE SET pick_backlog=EXCLUDED.pick_backlog,
        no_riders_since=CASE WHEN ${ridersAvailable} THEN NULL ELSE COALESCE(store_operational_signals.no_riders_since,EXCLUDED.no_riders_since) END,
        observed_at=clock_timestamp() RETURNING no_riders_since,observed_at`.execute(tx);
      const signal = result.rows[0]!;
      const reason =
        pickBacklog > backlog
          ? 'AUTO_PICK_BACKLOG'
          : signal.no_riders_since &&
              signal.observed_at.getTime() - signal.no_riders_since.getTime() >= minutes * 60_000
            ? 'AUTO_NO_RIDERS'
            : null;
      if (!reason || store.rows[0].status !== 'ONLINE') return;
      const changed = await sql<{
        version: string;
        updated_at: Date;
      }>`UPDATE stores SET status='PAUSED',pause_reason=${reason},version=version+1,updated_at=clock_timestamp() WHERE id=${storeId} RETURNING version::text,updated_at`.execute(
        tx,
      );
      const row = changed.rows[0]!;
      await sql`INSERT INTO store_status_history(store_id,version,previous_status,status,reason,actor_id) VALUES (${storeId},${row.version}::bigint,'ONLINE','PAUSED',${reason},NULL)`.execute(
        tx,
      );
      await sql`INSERT INTO audit_log(id,actor_id,action,subject_type,subject_id,details) VALUES(${uuidV7()},NULL,'STORE_AUTO_PAUSED','store',${storeId},${JSON.stringify({ reason })}::jsonb)`.execute(
        tx,
      );
      await sql`INSERT INTO outbox_events(id,event_type,schema_version,aggregate_type,aggregate_id,aggregate_version,occurred_at,correlation_id,causation_id,payload) VALUES (${uuidV7()},'store.status_changed',1,'store',${storeId},${row.version}::bigint,${row.updated_at},${correlationId},NULL,${JSON.stringify({ previous: 'ONLINE', status: 'PAUSED', reason })}::jsonb)`.execute(
        tx,
      );
    });
  }
  async evaluateDue(correlationId: string, limit = 100): Promise<number> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000)
      throw new Error('INVALID_STORE_SIGNAL_LIMIT');
    const { minutes } = await this.settings();
    const due = await sql<{
      store_id: string;
      pick_backlog: number | null;
    }>`SELECT o.store_id,o.pick_backlog FROM store_operational_signals o
      JOIN stores s ON s.id=o.store_id WHERE s.status='ONLINE' AND o.no_riders_since IS NOT NULL
      AND o.no_riders_since + ${minutes} * interval '1 minute' <= clock_timestamp() ORDER BY o.no_riders_since,o.store_id LIMIT ${limit}`.execute(
      this.db,
    );
    for (const row of due.rows) await this.evaluateExisting(row.store_id, correlationId);
    return due.rows.length;
  }
  private async evaluateExisting(storeId: string, correlationId: string): Promise<void> {
    const { minutes } = await this.settings();
    await this.db.transaction().execute(async (tx) => {
      const store = await sql<{
        status: string;
      }>`SELECT status FROM stores WHERE id=${storeId} FOR UPDATE`.execute(tx);
      if (store.rows[0]?.status !== 'ONLINE') return;
      const signal = await sql<{
        due: boolean;
      }>`SELECT no_riders_since IS NOT NULL AND no_riders_since + ${minutes} * interval '1 minute' <= clock_timestamp() AS due FROM store_operational_signals WHERE store_id=${storeId} FOR UPDATE`.execute(
        tx,
      );
      if (!signal.rows[0]?.due) return;
      const changed = await sql<{
        version: string;
        updated_at: Date;
      }>`UPDATE stores SET status='PAUSED',pause_reason='AUTO_NO_RIDERS',version=version+1,updated_at=clock_timestamp() WHERE id=${storeId} RETURNING version::text,updated_at`.execute(
        tx,
      );
      const row = changed.rows[0]!;
      await sql`INSERT INTO store_status_history(store_id,version,previous_status,status,reason,actor_id) VALUES (${storeId},${row.version}::bigint,'ONLINE','PAUSED','AUTO_NO_RIDERS',NULL)`.execute(
        tx,
      );
      await sql`INSERT INTO audit_log(id,actor_id,action,subject_type,subject_id,details) VALUES(${uuidV7()},NULL,'STORE_AUTO_PAUSED','store',${storeId},'{"reason":"AUTO_NO_RIDERS"}'::jsonb)`.execute(
        tx,
      );
      await sql`INSERT INTO outbox_events(id,event_type,schema_version,aggregate_type,aggregate_id,aggregate_version,occurred_at,correlation_id,causation_id,payload) VALUES (${uuidV7()},'store.status_changed',1,'store',${storeId},${row.version}::bigint,${row.updated_at},${correlationId},NULL,'{"previous":"ONLINE","status":"PAUSED","reason":"AUTO_NO_RIDERS"}'::jsonb)`.execute(
        tx,
      );
    });
  }
}
