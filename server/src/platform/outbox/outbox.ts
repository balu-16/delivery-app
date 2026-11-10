import { sql } from 'kysely';
import { uuidV7 } from '../../common/ids/ids.js';
import { type Database, type Json, type TransactionContext } from '../database/database.js';

export interface EventEnvelope {
  eventId: string;
  eventType: string;
  schemaVersion: number;
  aggregateType: string;
  aggregateId: string;
  aggregateVersion: string;
  occurredAt: string;
  correlationId: string;
  causationId: string | null;
  payload: Json;
}
export interface ClaimedDelivery {
  event: EventEnvelope;
  consumer: string;
  token: string;
}
export interface FailedDelivery {
  eventId: string;
  consumer: string;
  attempts: number;
  suspendedAt: Date;
  lastError: string | null;
}
interface ClaimedRow {
  id: string;
  event_type: string;
  schema_version: number;
  aggregate_type: string;
  aggregate_id: string;
  aggregate_version: string;
  occurred_at: Date;
  correlation_id: string;
  causation_id: string | null;
  payload: Json;
  consumer: string;
  lease_token: string;
}

/** Call inside the aggregate's mutation transaction; consumer obligations commit with the event. */
export async function appendEvent(
  tx: TransactionContext,
  event: EventEnvelope,
  consumers: readonly string[],
): Promise<void> {
  if (new Set(consumers).size !== consumers.length || consumers.some((c) => !c || c.length > 128))
    throw new Error('INVALID_EVENT_CONSUMERS');
  // The event and all of its obligations remain in the caller's transaction.
  // A single statement also avoids one remote database round trip per consumer.
  await sql`WITH inserted AS (
      INSERT INTO outbox_events(id,event_type,schema_version,aggregate_type,aggregate_id,aggregate_version,occurred_at,correlation_id,causation_id,payload)
      VALUES (${event.eventId}::uuid,${event.eventType},${event.schemaVersion},${event.aggregateType},${event.aggregateId}::uuid,${event.aggregateVersion}::bigint,${event.occurredAt}::timestamptz,${event.correlationId},${event.causationId},${JSON.stringify(event.payload)}::jsonb)
      RETURNING id
    ) INSERT INTO outbox_deliveries(event_id,consumer)
      SELECT inserted.id, targets.consumer FROM inserted
      CROSS JOIN unnest(${[...consumers]}::text[]) AS targets(consumer)`.execute(tx);
}

export class OutboxStore {
  constructor(private readonly db: Database) {}

  /** Claims commit before publication. Expired claims are recoverable. */
  async claim(limit = 50, leaseSeconds = 30): Promise<ClaimedDelivery[]> {
    if (
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 500 ||
      !Number.isSafeInteger(leaseSeconds) ||
      leaseSeconds < 1 ||
      leaseSeconds > 3600
    )
      throw new Error('INVALID_OUTBOX_CLAIM');
    const token = uuidV7();
    return this.db.transaction().execute(async (tx) => {
      const result = await sql<ClaimedRow>`WITH due AS (
          SELECT event_id, consumer FROM outbox_deliveries
          WHERE completed_at IS NULL AND suspended_at IS NULL AND next_publish_at <= clock_timestamp()
            AND (lease_until IS NULL OR lease_until <= clock_timestamp())
          ORDER BY next_publish_at,event_id,consumer FOR UPDATE SKIP LOCKED LIMIT ${limit}
        ), claimed AS (
          UPDATE outbox_deliveries d SET lease_token=${token}::uuid, lease_until=clock_timestamp()+${leaseSeconds}*interval '1 second', publish_attempts=d.publish_attempts+1
          FROM due WHERE d.event_id=due.event_id AND d.consumer=due.consumer
          RETURNING d.event_id,d.consumer,d.lease_token
        ) SELECT e.id,e.event_type,e.schema_version,e.aggregate_type,e.aggregate_id,e.aggregate_version::text,e.occurred_at,e.correlation_id,e.causation_id,e.payload,c.consumer,c.lease_token
          FROM claimed c JOIN outbox_events e ON e.id=c.event_id`.execute(tx);
      return result.rows.map((r) => ({
        token: r.lease_token,
        consumer: r.consumer,
        event: {
          eventId: r.id,
          eventType: r.event_type,
          schemaVersion: r.schema_version,
          aggregateType: r.aggregate_type,
          aggregateId: r.aggregate_id,
          aggregateVersion: r.aggregate_version,
          occurredAt: r.occurred_at.toISOString(),
          correlationId: r.correlation_id,
          causationId: r.causation_id,
          payload: r.payload,
        },
      }));
    });
  }

  /** Enqueue acknowledgement is not business completion: incomplete obligations become due again. */
  async acknowledge(delivery: ClaimedDelivery, retrySeconds = 60): Promise<boolean> {
    if (!Number.isSafeInteger(retrySeconds) || retrySeconds < 1) throw new Error('INVALID_RETRY');
    const result =
      await sql`UPDATE outbox_deliveries SET lease_token=NULL,lease_until=NULL,last_enqueued_at=clock_timestamp(),next_publish_at=clock_timestamp()+${retrySeconds}*interval '1 second',last_error=NULL
      WHERE event_id=${delivery.event.eventId}::uuid AND consumer=${delivery.consumer} AND lease_token=${delivery.token}::uuid`.execute(
        this.db,
      );
    return Number(result.numAffectedRows ?? 0) === 1;
  }
  async fail(delivery: ClaimedDelivery, retrySeconds = 10): Promise<void> {
    if (!Number.isSafeInteger(retrySeconds) || retrySeconds < 1) throw new Error('INVALID_RETRY');
    await sql`UPDATE outbox_deliveries SET lease_token=NULL,lease_until=NULL,next_publish_at=clock_timestamp()+${retrySeconds}*interval '1 second',last_error='enqueue failed'
      WHERE event_id=${delivery.event.eventId}::uuid AND consumer=${delivery.consumer} AND lease_token=${delivery.token}::uuid`.execute(
      this.db,
    );
  }
  async publishDue(
    publish: (delivery: ClaimedDelivery) => Promise<void>,
    limit = 50,
    onPublishFailure: () => void = () => undefined,
  ): Promise<number> {
    const deliveries = await this.claim(limit);
    for (let index = 0; index < deliveries.length; index++) {
      const delivery = deliveries[index]!;
      try {
        await publish(delivery);
        await this.acknowledge(delivery);
      } catch {
        onPublishFailure();
        // A transport outage should incur one command deadline per batch, not
        // one per delivery. Release the remaining claims for a later poll.
        for (const pending of deliveries.slice(index)) await this.fail(pending);
        break;
      }
    }
    return deliveries.length;
  }
  /** Database is authoritative even when Redis loses queued jobs. */
  async metrics(): Promise<{ pending: number; suspended: number; oldestSeconds: number }> {
    const result = await sql<{ pending: string; suspended: string; oldest_seconds: string }>`
      SELECT count(*) FILTER (WHERE d.suspended_at IS NULL)::text AS pending,
        count(*) FILTER (WHERE d.suspended_at IS NOT NULL)::text AS suspended,
        COALESCE(GREATEST(0, EXTRACT(EPOCH FROM (clock_timestamp() - min(e.occurred_at) FILTER (WHERE d.suspended_at IS NULL)))), 0)::text AS oldest_seconds
      FROM outbox_deliveries d JOIN outbox_events e ON e.id=d.event_id
      WHERE d.completed_at IS NULL`.execute(this.db);
    const row = result.rows[0];
    return {
      pending: Number(row?.pending ?? 0),
      suspended: Number(row?.suspended ?? 0),
      oldestSeconds: Number(row?.oldest_seconds ?? 0),
    };
  }
  /** Bounded operator view; payloads are intentionally excluded. */
  async listFailed(limit = 50): Promise<FailedDelivery[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500)
      throw new Error('INVALID_FAILED_DELIVERY_LIMIT');
    const result = await sql<{
      event_id: string;
      consumer: string;
      processing_attempts: number;
      suspended_at: Date;
      last_error: string | null;
    }>`SELECT event_id,consumer,processing_attempts,suspended_at,last_error FROM outbox_deliveries
      WHERE suspended_at IS NOT NULL AND completed_at IS NULL ORDER BY suspended_at DESC,event_id,consumer LIMIT ${limit}`.execute(
      this.db,
    );
    return result.rows.map((row) => ({
      eventId: row.event_id,
      consumer: row.consumer,
      attempts: row.processing_attempts,
      suspendedAt: row.suspended_at,
      lastError: row.last_error,
    }));
  }
  /** Operator replay reuses the original consumer/event key, resetting the bounded attempt budget. */
  async replay(eventId: string, consumer: string): Promise<void> {
    await sql`UPDATE outbox_deliveries SET suspended_at=NULL,processing_attempts=0,next_publish_at=clock_timestamp(),lease_token=NULL,lease_until=NULL,last_error=NULL
      WHERE event_id=${eventId}::uuid AND consumer=${consumer} AND completed_at IS NULL AND suspended_at IS NOT NULL`.execute(
      this.db,
    );
  }
}
