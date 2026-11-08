import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { sql } from 'kysely';
import { type Database, type Json } from '../database/database.js';
import { consumeOnce, failDeliveryAttempt } from '../events/consume.js';
import { OutboxStore, type EventEnvelope } from '../outbox/outbox.js';
import type { EventHandler } from './queue.js';
import { SqsBatchWorker } from './sqs-batch-worker.js';
import type { SqsJobPointer, SqsTransport } from './sqs-transport.js';

interface EventRow {
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
  completed_at: Date | null;
  suspended_at: Date | null;
}

const digest = (consumer: string) => createHash('sha256').update(consumer).digest('hex');
const eventIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** SQS carries only the event ID and a hash of its consumer; payloads stay in PostgreSQL. */
export function eventPointer(eventId: string, consumer: string): SqsJobPointer {
  if (!eventIdPattern.test(eventId) || !consumer || consumer.length > 128)
    throw new Error('INVALID_EVENT_POINTER');
  return { version: 1, jobId: `${eventId.toLowerCase()}-${digest(consumer)}`, generation: 1 };
}

export class SqsEventQueue {
  readonly outbox: OutboxStore;
  private readonly handlers = new Map<string, EventHandler>();
  private readonly worker: SqsBatchWorker;
  private readonly abort = new AbortController();
  private timer?: ReturnType<typeof setInterval>;
  private recovery?: Promise<void>;
  private polling?: Promise<void>;
  private relayClaims = 0;
  private relayFailures = 0;
  private jobsCompleted = 0;
  private jobsFailed = 0;
  private readonly onError: (error: Error) => void;

  constructor(
    private readonly options: {
      db: Database;
      transport: SqsTransport;
      consume?: boolean;
      maxAttempts?: number;
      concurrency?: number;
      onError?: (error: Error) => void;
    },
  ) {
    if (
      !Number.isSafeInteger(options.maxAttempts ?? 5) ||
      (options.maxAttempts ?? 5) < 1 ||
      (options.maxAttempts ?? 5) > 100 ||
      !Number.isSafeInteger(options.concurrency ?? 4) ||
      (options.concurrency ?? 4) < 1 ||
      (options.concurrency ?? 4) > 100
    )
      throw new Error('INVALID_QUEUE_CONFIGURATION');
    this.onError = options.onError ?? (() => undefined);
    this.outbox = new OutboxStore(options.db);
    this.worker = new SqsBatchWorker(
      options.transport,
      (pointer) => this.processPointer(pointer),
      this.onError,
      Math.min(10, options.concurrency ?? 4),
    );
  }

  registerHandler(name: string, handler: EventHandler): void {
    if (!name || name.length > 128 || this.handlers.has(name))
      throw new Error('INVALID_OR_DUPLICATE_CONSUMER');
    this.handlers.set(name, handler);
  }

  async processPointer(pointer: SqsJobPointer): Promise<void> {
    const match = /^([0-9a-f-]{36})-([0-9a-f]{64})$/.exec(pointer.jobId);
    if (
      pointer.version !== 1 ||
      pointer.generation !== 1 ||
      !match ||
      !eventIdPattern.test(match[1]!)
    )
      throw new Error('INVALID_EVENT_POINTER');
    const rows =
      await sql<EventRow>`SELECT e.id,e.event_type,e.schema_version,e.aggregate_type,e.aggregate_id,e.aggregate_version::text,e.occurred_at,e.correlation_id,e.causation_id,e.payload,d.consumer,d.completed_at,d.suspended_at
      FROM outbox_events e JOIN outbox_deliveries d ON d.event_id=e.id WHERE e.id=${match[1]}::uuid`.execute(
        this.options.db,
      );
    const candidates = rows.rows.filter((row) => digest(row.consumer) === match[2]);
    if (candidates.length !== 1) throw new Error('EVENT_DELIVERY_NOT_FOUND');
    const row = candidates[0]!;
    if (row.completed_at || row.suspended_at) return;
    const handler = this.handlers.get(row.consumer);
    if (!handler) {
      await failDeliveryAttempt(
        this.options.db,
        row.id,
        row.consumer,
        this.options.maxAttempts ?? 5,
      );
      throw new Error('UNREGISTERED_CONSUMER');
    }
    const event: EventEnvelope = {
      eventId: row.id,
      eventType: row.event_type,
      schemaVersion: row.schema_version,
      aggregateType: row.aggregate_type,
      aggregateId: row.aggregate_id,
      aggregateVersion: row.aggregate_version,
      occurredAt: row.occurred_at.toISOString(),
      correlationId: row.correlation_id,
      causationId: row.causation_id,
      payload: row.payload,
    };
    try {
      await consumeOnce(this.options.db, row.id, row.consumer, async (tx) => handler(tx, event));
    } catch (error) {
      await failDeliveryAttempt(
        this.options.db,
        row.id,
        row.consumer,
        this.options.maxAttempts ?? 5,
      );
      throw error;
    }
  }

  async recoverOnce(limit = 50): Promise<number> {
    try {
      const count = await this.outbox.publishDue(
        async ({ event, consumer }) => {
          await this.options.transport.send(
            'platform-events',
            eventPointer(event.eventId, consumer),
          );
        },
        limit,
        () => {
          this.relayFailures++;
        },
      );
      this.relayClaims += count;
      return count;
    } catch (error) {
      this.relayFailures++;
      throw error;
    }
  }

  startRecovery(intervalMs = 500): void {
    if (!Number.isSafeInteger(intervalMs) || intervalMs < 100 || intervalMs > 60000 || this.timer)
      throw new Error('INVALID_RECOVERY_INTERVAL');
    if (this.options.consume !== false) this.polling = this.poll();
    this.timer = setInterval(() => {
      if (this.recovery) return;
      this.recovery = this.recoverOnce()
        .then(() => undefined)
        .catch(() => this.onError(new Error('SQS_EVENT_RELAY_FAILED')))
        .finally(() => {
          this.recovery = undefined;
        });
    }, intervalMs);
    this.timer.unref();
  }

  private async poll(): Promise<void> {
    while (!this.abort.signal.aborted) {
      try {
        const result = await this.worker.runOnce('platform-events', this.abort.signal);
        this.jobsCompleted += result.completed;
        this.jobsFailed += result.failed + result.malformed;
      } catch {
        if (!this.abort.signal.aborted) {
          this.onError(new Error('SQS_EVENT_POLL_FAILED'));
          await delay(1000);
        }
      }
    }
  }

  stats() {
    return {
      relayClaims: this.relayClaims,
      relayFailures: this.relayFailures,
      jobsCompleted: this.jobsCompleted,
      jobsFailed: this.jobsFailed,
      recovering: !!this.recovery,
    };
  }
  async ping(): Promise<void> {
    await this.options.transport.ping('platform-events');
  }
  async depths(): Promise<{ waiting: number; active: number; delayed: number; failed: number }> {
    const [counts, failed] = await Promise.all([
      this.options.transport.counts('platform-events'),
      sql<{
        count: string;
      }>`SELECT count(*)::text AS count FROM outbox_deliveries WHERE suspended_at IS NOT NULL AND completed_at IS NULL`.execute(
        this.options.db,
      ),
    ]);
    return { ...counts, failed: Number(failed.rows[0]?.count ?? 0) };
  }
  async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.abort.abort();
    await this.polling;
    await this.recovery;
  }
}
