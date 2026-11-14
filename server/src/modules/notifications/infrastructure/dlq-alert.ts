import { sql } from 'kysely';
import { transactionWithRetry, type Database } from '../../../platform/database/database.js';
import { OutboxStore } from '../../../platform/outbox/outbox.js';
import type { NotificationPipeline } from '../contracts/notifications.js';

const DEFAULT_THRESHOLD = 10;
const BOUNDED_SAMPLE = 100;

/**
 * Admin alert on dead-letter growth (suspended outbox deliveries or failed
 * notification sends). Dedupe limits it to one alert per UTC hour; the
 * insert reuses the pipeline so preferences and channels behave normally.
 */
export class DlqGrowthAlert {
  private readonly outbox: OutboxStore;
  constructor(
    private readonly db: Database,
    private readonly pipeline: NotificationPipeline,
    private readonly threshold = DEFAULT_THRESHOLD,
  ) {
    this.outbox = new OutboxStore(db);
  }
  /** Returns the number of alerts written (0 or the recipient count). */
  async runOnce(): Promise<number> {
    const suspended = await this.outbox.listFailed(BOUNDED_SAMPLE);
    const failed = await sql<{
      count: string;
    }>`SELECT count(*)::text AS count FROM notification_deliveries d JOIN notifications n ON n.id=d.notification_id WHERE d.status='FAILED' AND n.template_key <> 'admin.dlq_growth' AND d.updated_at>clock_timestamp()-interval '24 hours'`.execute(
      this.db,
    );
    const failedNotifications = Number(failed.rows[0]?.count ?? '0');
    const errors = await sql<{
      count: string;
    }>`SELECT count(*)::text AS count FROM notification_event_errors WHERE created_at>clock_timestamp()-interval '24 hours'`.execute(
      this.db,
    );
    const eventErrors = Number(errors.rows[0]?.count ?? '0');
    if (
      suspended.length < this.threshold &&
      failedNotifications < this.threshold &&
      eventErrors < this.threshold
    )
      return 0;
    const admins = await sql<{
      id: string;
    }>`SELECT u.id FROM users u JOIN user_roles r ON r.user_id=u.id WHERE r.role IN ('SUPER_ADMIN') AND u.status='ACTIVE' ORDER BY u.id LIMIT 500`.execute(
      this.db,
    );
    if (!admins.rows.length) return 0;
    const hour = new Date().toISOString().slice(0, 13);
    return transactionWithRetry(this.db, async (tx) => {
      const inserted = await this.pipeline.notifyRecipient({
        tx,
        recipientIds: admins.rows.map((row) => row.id),
        templateKey: 'admin.dlq_growth',
        category: 'ADMIN',
        class: 'TRANSACTIONAL',
        channels: ['INBOX'],
        data: {
          failed: String(failedNotifications),
          suspended: String(suspended.length),
          eventErrors: String(eventErrors),
        },
        dedupeContext: {
          eventType: 'ops.dlq_growth',
          aggregateId: 'platform',
          transitionVersion: hour,
        },
      });
      return inserted;
    });
  }
}
