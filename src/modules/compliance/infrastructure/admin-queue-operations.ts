import { sql } from 'kysely';
import { uuidV7 } from '../../../common/ids/ids.js';
import type { Database } from '../../../platform/database/database.js';
import { CONCERNS, type QueueConcern } from '../../../platform/queue/concerns.js';
import type { ConcernQueues } from '../../../platform/queue/concern-queues.js';
const replayable: Partial<Record<QueueConcern, readonly string[]>> = {
  imports: ['catalog-import'],
  notifications: ['deliver'],
  payments: ['process-webhook'],
  subscriptions: ['generate'],
  maintenance: ['p11-scan'],
};
const outboxConsumers = [
  'orders',
  'wallet',
  'invoicing',
  'dispatch',
  'dispatch-trigger',
  'dispatch-realtime',
  'picking',
  'inventory-shortfalls',
  'notifications',
];
export class AdminQueueOperations {
  constructor(
    private readonly db: Database,
    private readonly queues?: ConcernQueues,
  ) {}
  private concern(value: string): QueueConcern {
    if (!CONCERNS.includes(value as QueueConcern)) throw new Error('INVALID_QUEUE_CONCERN');
    return value as QueueConcern;
  }
  async failed(value: string) {
    const concern = this.concern(value);
    if (!this.queues) throw new Error('QUEUE_UNAVAILABLE');
    return this.queues.listFailed(concern, 100);
  }
  async replay(value: string, id: string, actor: string, reason: string) {
    const concern = this.concern(value);
    if (!this.queues) throw new Error('QUEUE_UNAVAILABLE');
    if (!/^[a-f0-9]{64}$/.test(id) || !reason.trim() || reason.length > 300)
      throw new Error('INVALID_REPLAY');
    const job = await this.queues.getFailed(concern, id);
    if (!job || !replayable[concern]?.includes(job.name)) throw new Error('FAILED_JOB_NOT_FOUND');
    await this.audit(actor, 'QUEUE_REPLAY_REQUESTED', `${concern}:${id}`, reason);
    await this.queues.replay(concern, id);
  }
  async outbox() {
    const result = await sql`SELECT count(*) FILTER (WHERE completed_at IS NULL)::text AS pending,
      count(*) FILTER (WHERE completed_at IS NULL AND suspended_at IS NOT NULL)::text AS suspended,
      min(e.occurred_at) FILTER (WHERE d.completed_at IS NULL) AS oldest_pending,
      (SELECT max(processed_at) FROM processed_events) AS latest_processed
      FROM outbox_deliveries d JOIN outbox_events e ON e.id=d.event_id`.execute(this.db);
    return result.rows[0];
  }
  async replayOutbox(eventId: string, consumer: string, actor: string, reason: string) {
    if (!outboxConsumers.includes(consumer) || !reason.trim() || reason.length > 300)
      throw new Error('INVALID_REPLAY');
    await this.db.transaction().execute(async (tx) => {
      const result =
        await sql`UPDATE outbox_deliveries SET suspended_at=NULL,processing_attempts=0,next_publish_at=clock_timestamp(),lease_token=NULL,lease_until=NULL,last_error=NULL WHERE event_id=${eventId}::uuid AND consumer=${consumer} AND completed_at IS NULL AND suspended_at IS NOT NULL RETURNING event_id`.execute(
          tx,
        );
      if (!result.rows.length) throw new Error('FAILED_JOB_NOT_FOUND');
      await sql`INSERT INTO audit_log(id,actor_id,action,subject_type,subject_id,details) VALUES (${uuidV7()}::uuid,${actor}::uuid,'OUTBOX_REPLAY','outbox',${eventId},${JSON.stringify({ consumer, reason: reason.trim() })}::jsonb)`.execute(
        tx,
      );
    });
  }
  private async audit(actor: string, action: string, subject: string, reason: string) {
    await sql`INSERT INTO audit_log(id,actor_id,action,subject_type,subject_id,details) VALUES (${uuidV7()}::uuid,${actor}::uuid,${action},'queue',${subject},${JSON.stringify({ reason: reason.trim() })}::jsonb)`.execute(
      this.db,
    );
  }
}
