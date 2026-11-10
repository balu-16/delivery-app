import { sql } from 'kysely';
import { uuidV7 } from '../../../common/ids/ids.js';
import { transactionWithRetry, type Database } from '../../../platform/database/database.js';
import { appendEvent } from '../../../platform/outbox/outbox.js';
import type { AppConfig } from '../../app-config/contracts/config.js';
import { loadTask, taskHistory, taskEvent } from './pick-primitives.js';

export async function recoverDisconnected(db: Database, config: AppConfig): Promise<void> {
  const minutes = await config.get('pickingDisconnectMinutes');
  const stale = await sql<{
    id: string;
    order_id: string;
  }>`SELECT id,order_id FROM pick_tasks WHERE status IN ('ASSIGNED','IN_PROGRESS')
   AND last_activity_at<clock_timestamp()-${minutes}*interval '1 minute' ORDER BY last_activity_at LIMIT 100`.execute(
    db,
  );
  for (const candidate of stale.rows)
    await transactionWithRetry(db, async (tx) => {
      await sql`SELECT id FROM orders WHERE id=${candidate.order_id}::uuid FOR UPDATE`.execute(tx);
      const task = await loadTask(tx, candidate.id, true);
      if (!task || !['ASSIGNED', 'IN_PROGRESS'].includes(task.status)) return;
      const updated =
        await sql`UPDATE pick_tasks SET status='PENDING',assigned_to=NULL,last_activity_at=clock_timestamp(),version=version+1
     WHERE id=${candidate.id}::uuid AND last_activity_at<clock_timestamp()-${minutes}*interval '1 minute' RETURNING id`.execute(
          tx,
        );
      if (!updated.rows.length) return;
      await taskHistory(tx, task.id, task.status, 'PENDING', null, 'PICKER_DISCONNECTED');
      await taskEvent(
        tx,
        task.id,
        task.order_id,
        'picking.task_changed',
        { previous: task.status, status: 'PENDING', reason: 'PICKER_DISCONNECTED' },
        ['notifications'],
      );
    });
  const threshold = await config.get('pickingShortRateAlertBps');
  if (threshold <= 0) return;
  await transactionWithRetry(db, async (tx) => {
    const rates = await sql<{
      store_id: string;
      picker_id: string;
      total: string;
      shorts: string;
    }>`SELECT t.store_id,t.completed_by AS picker_id,
     count(*)::text AS total,count(*) FILTER(WHERE i.status='SHORT')::text AS shorts
     FROM pick_tasks t JOIN pick_items i ON i.task_id=t.id WHERE t.completed_at>=date_trunc('day',clock_timestamp()) AND t.completed_by IS NOT NULL
     GROUP BY t.store_id,t.completed_by HAVING count(*)>=10 AND count(*) FILTER(WHERE i.status='SHORT')*10000>=count(*)*${threshold}`.execute(
      tx,
    );
    for (const rate of rates.rows) {
      const id = uuidV7();
      const inserted = await sql`INSERT INTO picking_operational_alerts(id,store_id,kind,period)
       VALUES(${id}::uuid,${rate.store_id}::uuid,${`SHORT_RATE:${rate.picker_id}`},current_date) ON CONFLICT DO NOTHING RETURNING id`.execute(
        tx,
      );
      if (!inserted.rows.length) continue;
      await appendEvent(
        tx,
        {
          eventId: uuidV7(),
          eventType: 'ops.anomaly',
          schemaVersion: 1,
          aggregateType: 'picking_alert',
          aggregateId: id,
          aggregateVersion: '1',
          occurredAt: new Date().toISOString(),
          correlationId: rate.store_id,
          causationId: null,
          payload: {
            storeId: rate.store_id,
            kind: 'PICKER_SHORT_RATE',
            pickerId: rate.picker_id,
            detail: 'Picker short rate exceeded the configured threshold',
          },
        },
        ['notifications'],
      );
    }
  });
}
