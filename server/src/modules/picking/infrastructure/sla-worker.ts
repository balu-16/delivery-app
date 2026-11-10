import { sql } from 'kysely';
import { uuidV7 } from '../../../common/ids/ids.js';
import { transactionWithRetry, type Database } from '../../../platform/database/database.js';
import type { StoreSignals } from '../../stores/contracts/signals.js';

/**
 * Maintenance: records SLA breaches for overdue active tasks (idempotent,
 * one row per task) and reports the per-store pick backlog to the existing
 * store auto-pause evaluator. Rider availability is passed through unchanged
 * so P7 never clobbers P8's no-rider signal.
 */
export class PickingSlaWorker {
  constructor(
    private readonly db: Database,
    private readonly signals: StoreSignals,
  ) {}
  async runOnce(): Promise<{ breaches: number; stores: number }> {
    let breaches = 0;
    await transactionWithRetry(this.db, async (tx) => {
      const due = await sql<{
        id: string;
        order_id: string;
        store_id: string;
      }>`SELECT t.id,t.order_id,t.store_id FROM pick_tasks t WHERE t.status IN ('PENDING','ASSIGNED','IN_PROGRESS') AND t.sla_due_at<clock_timestamp() AND NOT EXISTS (SELECT 1 FROM picking_sla_breaches b WHERE b.task_id=t.id) LIMIT 200`.execute(
        tx,
      );
      for (const task of due.rows) {
        const inserted =
          await sql`INSERT INTO picking_sla_breaches(id,task_id,store_id) VALUES(${uuidV7()}::uuid,${task.id}::uuid,${task.store_id}::uuid) ON CONFLICT (task_id) DO NOTHING RETURNING id`.execute(
            tx,
          );
        if (!inserted.rows.length) continue;
        breaches += 1;
        const breachEventId = uuidV7();
        await sql`INSERT INTO outbox_events(id,event_type,schema_version,aggregate_type,aggregate_id,aggregate_version,correlation_id,payload) VALUES(${breachEventId}::uuid,'picking.sla_breached',1,'pick_task',${task.id}::uuid,1::bigint,${task.order_id},${JSON.stringify({ taskId: task.id, orderId: task.order_id, storeId: task.store_id })}::jsonb)`.execute(
          tx,
        );
        await sql`INSERT INTO outbox_deliveries(event_id,consumer) VALUES(${breachEventId}::uuid,'notifications')`.execute(
          tx,
        );
      }
    });
    const stores = await sql<{
      store_id: string;
      backlog: string;
      no_riders_since: Date | null;
    }>`SELECT i.id AS store_id,COALESCE(sum(CASE WHEN t.status IN ('PENDING','ASSIGNED','IN_PROGRESS') THEN 1 ELSE 0 END),0)::text AS backlog,(SELECT s.no_riders_since FROM store_operational_signals s WHERE s.store_id=i.id ORDER BY s.observed_at DESC LIMIT 1) AS no_riders_since FROM stores i LEFT JOIN pick_tasks t ON t.store_id=i.id WHERE EXISTS (SELECT 1 FROM pick_tasks t2 WHERE t2.store_id=i.id) GROUP BY i.id`.execute(
      this.db,
    );
    for (const store of stores.rows) {
      await this.signals.observe(
        store.store_id,
        Number(store.backlog),
        store.no_riders_since === null,
        `picking-backlog-${uuidV7()}`,
      );
    }
    return { breaches, stores: stores.rows.length };
  }
}
