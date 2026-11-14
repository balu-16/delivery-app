import { sql } from 'kysely';
import { uuidV7 } from '../../../common/ids/ids.js';
import type { Database } from '../../../platform/database/database.js';
import type { AppConfig } from '../../app-config/contracts/config.js';
/** Configurable, bounded, advisory scans: they never alter account or order state. */
export class FraudReviewScanner {
  constructor(
    private readonly db: Database,
    private readonly config: AppConfig,
  ) {}
  async runOnce(): Promise<void> {
    const [hours, payments, cancellations, cod, coupons, kph, shortBps, minLines] =
      await Promise.all([
        this.config.get('fraudWindowHours'),
        this.config.get('fraudFailedPaymentThreshold'),
        this.config.get('fraudCancellationThreshold'),
        this.config.get('fraudCodRefusalThreshold'),
        this.config.get('fraudCouponHoardThreshold'),
        this.config.get('fraudImpossibleGpsKph'),
        this.config.get('fraudPickerShortRateBps'),
        this.config.get('fraudPickerMinLines'),
      ]);
    const scans = [
      sql<{
        user_id: string;
        n: string;
      }>`SELECT user_id,count(*)::text AS n FROM payment_attempts WHERE status='FAILED' AND user_id IS NOT NULL AND created_at>=clock_timestamp()-${hours}*interval '1 hour' GROUP BY user_id HAVING count(*)>=${payments} ORDER BY user_id LIMIT 500`,
      sql<{
        user_id: string;
        n: string;
      }>`SELECT user_id,count(*)::text AS n FROM orders WHERE status='CANCELLED' AND cancelled_at>=clock_timestamp()-${hours}*interval '1 hour' GROUP BY user_id HAVING count(*)>=${cancellations} ORDER BY user_id LIMIT 500`,
      sql<{
        user_id: string;
        n: string;
      }>`SELECT o.user_id,count(*)::text AS n FROM delivery_tasks t JOIN orders o ON o.id=t.order_id WHERE t.status='FAILED' AND t.failure_reason='COD_REFUSED' AND t.updated_at>=clock_timestamp()-${hours}*interval '1 hour' GROUP BY o.user_id HAVING count(*)>=${cod} ORDER BY o.user_id LIMIT 500`,
      sql<{
        user_id: string;
        n: string;
      }>`SELECT user_id,count(*)::text AS n FROM coupon_redemptions WHERE reserved_at>=clock_timestamp()-${hours}*interval '1 hour' GROUP BY user_id HAVING count(*)>=${coupons} ORDER BY user_id LIMIT 500`,
      sql<{
        user_id: string;
        n: string;
      }>`WITH samples AS (SELECT rider_id,ts,location,speed_mps,lag(ts) OVER (PARTITION BY rider_id ORDER BY ts) AS previous_ts,lag(location) OVER (PARTITION BY rider_id ORDER BY ts) AS previous_location FROM rider_location_history WHERE ts>=clock_timestamp()-${hours}*interval '1 hour') SELECT rider_id AS user_id,count(*)::text AS n FROM samples WHERE speed_mps*3.6>${kph} OR (previous_ts IS NOT NULL AND ts>previous_ts AND ST_Distance(location,previous_location)*3.6/EXTRACT(EPOCH FROM ts-previous_ts)>${kph}) GROUP BY rider_id ORDER BY rider_id LIMIT 500`,
      sql<{
        user_id: string;
        n: string;
      }>`SELECT t.completed_by AS user_id,count(*)::text AS n FROM pick_tasks t JOIN pick_items i ON i.task_id=t.id WHERE t.completed_at>=clock_timestamp()-${hours}*interval '1 hour' AND t.completed_by IS NOT NULL GROUP BY t.completed_by HAVING count(*)>=${minLines} AND count(*) FILTER(WHERE i.status='SHORT')*10000>=count(*)*${shortBps} ORDER BY t.completed_by LIMIT 500`,
    ];
    const kinds = [
      'REPEATED_PAYMENT_FAILURES',
      'REPEATED_CANCELLATIONS',
      'COD_REFUSALS',
      'COUPON_HOARDING',
      'IMPOSSIBLE_RIDER_GPS',
      'PICKER_SHORT_RATE',
    ];
    for (let index = 0; index < scans.length; index++) {
      const result = await scans[index]!.execute(this.db);
      for (let offset = 0; offset < result.rows.length; offset += 100)
        await this.recordBatch(kinds[index]!, result.rows.slice(offset, offset + 100));
    }
  }
  private async recordBatch(kind: string, rows: { user_id: string; n: string }[]): Promise<void> {
    if (!rows.length) return;
    await this.db.transaction().execute(async (tx) => {
      const ordered = [...rows].sort((a, b) => a.user_id.localeCompare(b.user_id));
      const input = ordered.map((row) => ({ id: uuidV7(), user_id: row.user_id, count: row.n }));
      // All scanners use the same sorted lock order, including across replicas.
      for (const row of ordered)
        await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`fraud:${kind}:${row.user_id}`},0))`.execute(
          tx,
        );
      const inserted = await sql<{ id: string }>`WITH input AS (
        SELECT * FROM jsonb_to_recordset(${JSON.stringify(input)}::jsonb) AS x(id uuid,user_id uuid,count text)
      ) INSERT INTO fraud_signals(id,user_id,kind,severity,reference,details)
        SELECT i.id,i.user_id,${kind},'WARN',${kind}||':'||i.user_id::text,jsonb_build_object('count',i.count)
        FROM input i WHERE NOT EXISTS (SELECT 1 FROM fraud_signals f WHERE f.kind=${kind} AND f.user_id=i.user_id
          AND (f.status='OPEN' OR f.created_at>clock_timestamp()-interval '1 day')) RETURNING id::text`.execute(
        tx,
      );
      if (!inserted.rows.length) return;
      const events = inserted.rows.map((row) => ({ event_id: uuidV7(), signal_id: row.id }));
      await sql`WITH input AS (
        SELECT * FROM jsonb_to_recordset(${JSON.stringify(events)}::jsonb) AS x(event_id uuid,signal_id uuid)
      ), created AS (
        INSERT INTO outbox_events(id,event_type,schema_version,aggregate_type,aggregate_id,aggregate_version,occurred_at,correlation_id,payload)
        SELECT event_id,'ops.anomaly',1,'fraud_signal',signal_id,1,clock_timestamp(),signal_id::text,
          jsonb_build_object('kind',${kind}::text,'signalId',signal_id::text) FROM input RETURNING id
      ) INSERT INTO outbox_deliveries(event_id,consumer) SELECT id,'notifications' FROM created`.execute(
        tx,
      );
    });
  }
}
