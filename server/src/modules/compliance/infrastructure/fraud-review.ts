import { sql } from 'kysely';
import { uuidV7 } from '../../../common/ids/ids.js';
import type { Database } from '../../../platform/database/database.js';
import { appendEvent } from '../../../platform/outbox/outbox.js';
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
      for (const row of result.rows) await this.record(kinds[index]!, row.user_id, row.n);
    }
  }
  private async record(kind: string, userId: string, n: string): Promise<void> {
    await this.db.transaction().execute(async (tx) => {
      const ref = `${kind}:${userId}`;
      await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`fraud:${ref}`},0))`.execute(tx);
      const open =
        await sql`SELECT 1 FROM fraud_signals WHERE kind=${kind} AND user_id=${userId}::uuid AND status='OPEN'`.execute(
          tx,
        );
      if (open.rows.length) return;
      const recent =
        await sql`SELECT 1 FROM fraud_signals WHERE kind=${kind} AND user_id=${userId}::uuid AND created_at>clock_timestamp()-interval '1 day'`.execute(
          tx,
        );
      if (recent.rows.length) return;
      const id = uuidV7();
      await sql`INSERT INTO fraud_signals(id,user_id,kind,severity,reference,details) VALUES (${id}::uuid,${userId}::uuid,${kind},'WARN',${ref},${JSON.stringify({ count: n })}::jsonb)`.execute(
        tx,
      );
      await appendEvent(
        tx,
        {
          eventId: uuidV7(),
          eventType: 'ops.anomaly',
          schemaVersion: 1,
          aggregateType: 'fraud_signal',
          aggregateId: id,
          aggregateVersion: '1',
          occurredAt: new Date().toISOString(),
          correlationId: id,
          causationId: null,
          payload: { kind, signalId: id },
        },
        ['notifications'],
      );
    });
  }
}
