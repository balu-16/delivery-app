import { createHash } from 'node:crypto';
import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { sql } from 'kysely';
import { type Database, type Json, type TransactionContext } from '../database/database.js';
import { consumeOnce, failDeliveryAttempt } from '../events/consume.js';
import { OutboxStore, type EventEnvelope } from '../outbox/outbox.js';

export type EventHandler = (tx: TransactionContext, event: EventEnvelope) => Promise<void>;
interface JobData {
  eventId: string;
  consumer: string;
}
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
}
export interface DurableQueueOptions {
  db: Database;
  redisUrl: string;
  prefix?: string;
  concurrency?: number;
  maxAttempts?: number;
  handlers?: Readonly<Record<string, EventHandler>>;
  onError?: (error: Error) => void;
  consume?: boolean;
  autorun?: boolean;
}
/** Redis is transport only; DB stores obligations, attempts, dead letters and completion. */
export class DurableQueue {
  readonly outbox: OutboxStore;
  private readonly connection: Redis;
  private readonly workerConnection?: Redis;
  private readonly queue: Queue<JobData>;
  private readonly worker?: Worker<JobData>;
  private timer: ReturnType<typeof setInterval> | undefined;
  private recovery?: Promise<void>;
  private readonly maxAttempts: number;
  private readonly onError: (error: Error) => void;
  private relayClaims = 0;
  private relayFailures = 0;
  private jobsCompleted = 0;
  private jobsFailed = 0;
  private readonly handlers = new Map<string, EventHandler>();

  constructor(private readonly options: DurableQueueOptions) {
    const concurrency = options.concurrency ?? 4;
    this.maxAttempts = options.maxAttempts ?? 5;
    if (
      !options.redisUrl ||
      !Number.isSafeInteger(concurrency) ||
      concurrency < 1 ||
      concurrency > 100 ||
      !Number.isSafeInteger(this.maxAttempts) ||
      this.maxAttempts < 1 ||
      this.maxAttempts > 100
    )
      throw new Error('INVALID_QUEUE_CONFIGURATION');
    this.onError = options.onError ?? (() => undefined);
    for (const [name, handler] of Object.entries(options.handlers ?? {}))
      this.registerHandler(name, handler);
    this.outbox = new OutboxStore(options.db);
    // BullMQ requires unlimited reconnects, but individual producer commands
    // still need a deadline so an outage cannot pin the relay indefinitely.
    this.connection = new Redis(options.redisUrl, {
      maxRetriesPerRequest: null,
      connectTimeout: 5000,
      commandTimeout: 5000,
    });
    const prefix = options.prefix ?? 'delivery';
    this.queue = new Queue<JobData>('platform-events', { connection: this.connection, prefix });
    this.queue.on('error', this.onError);
    this.connection.on('error', this.onError);
    if (options.consume !== false) {
      this.workerConnection = new Redis(options.redisUrl, {
        maxRetriesPerRequest: null,
        connectTimeout: 5000,
      });
      this.workerConnection.on('error', this.onError);
      this.worker = new Worker<JobData>('platform-events', async (job) => this.process(job.data), {
        connection: this.workerConnection,
        prefix,
        concurrency,
        autorun: options.autorun !== false,
      });
      this.worker.on('error', this.onError);
      this.worker.on('completed', () => {
        this.jobsCompleted++;
      });
      this.worker.on('failed', () => {
        this.jobsFailed++;
      });
    }
  }
  registerHandler(name: string, handler: EventHandler): void {
    if (!name || this.handlers.has(name)) throw new Error('INVALID_OR_DUPLICATE_CONSUMER');
    this.handlers.set(name, handler);
  }
  private async process(job: JobData): Promise<void> {
    try {
      const handler = this.handlers.get(job.consumer);
      if (!handler) throw new Error('UNREGISTERED_CONSUMER');
      const result =
        await sql<EventRow>`SELECT id,event_type,schema_version,aggregate_type,aggregate_id,aggregate_version::text,occurred_at,correlation_id,causation_id,payload FROM outbox_events WHERE id=${job.eventId}::uuid`.execute(
          this.options.db,
        );
      const e = result.rows[0];
      if (!e) throw new Error('EVENT_NOT_FOUND');
      const event: EventEnvelope = {
        eventId: e.id,
        eventType: e.event_type,
        schemaVersion: e.schema_version,
        aggregateType: e.aggregate_type,
        aggregateId: e.aggregate_id,
        aggregateVersion: e.aggregate_version,
        occurredAt: e.occurred_at.toISOString(),
        correlationId: e.correlation_id,
        causationId: e.causation_id,
        payload: e.payload,
      };
      await consumeOnce(this.options.db, job.eventId, job.consumer, async (tx) =>
        handler(tx, event),
      );
    } catch (error: unknown) {
      await failDeliveryAttempt(this.options.db, job.eventId, job.consumer, this.maxAttempts);
      throw error;
    }
  }
  /** Relay may run on several instances: outbox claim leases coordinate them. */
  async recoverOnce(limit = 50): Promise<number> {
    try {
      const claimed = await this.outbox.publishDue(
        async ({ event, consumer }) => {
          const suffix = createHash('sha256').update(consumer).digest('hex').slice(0, 16);
          await this.queue.add(
            'delivery',
            { eventId: event.eventId, consumer },
            {
              jobId: `${event.eventId}-${suffix}`,
              attempts: 1,
              removeOnComplete: true,
              removeOnFail: true,
            },
          );
        },
        limit,
        () => {
          this.relayFailures++;
        },
      );
      this.relayClaims += claimed;
      return claimed;
    } catch (error) {
      this.relayFailures++;
      throw error;
    }
  }
  stats(): {
    relayClaims: number;
    relayFailures: number;
    jobsCompleted: number;
    jobsFailed: number;
    recovering: boolean;
  } {
    return {
      relayClaims: this.relayClaims,
      relayFailures: this.relayFailures,
      jobsCompleted: this.jobsCompleted,
      jobsFailed: this.jobsFailed,
      recovering: !!this.recovery,
    };
  }
  startRecovery(intervalMs = 500): void {
    if (!Number.isSafeInteger(intervalMs) || intervalMs < 100 || intervalMs > 60000 || this.timer)
      throw new Error('INVALID_RECOVERY_INTERVAL');
    if (this.worker && !this.worker.isRunning())
      void this.worker.run().catch((error: Error) => this.onError(error));
    this.timer = setInterval(() => {
      if (this.recovery) return;
      this.recovery = this.recoverOnce()
        .then(() => undefined)
        .catch((error: unknown) =>
          this.onError(error instanceof Error ? error : new Error(String(error))),
        )
        .finally(() => {
          this.recovery = undefined;
        });
    }, intervalMs);
    this.timer.unref();
  }
  async depths(): Promise<{ waiting: number; active: number; delayed: number; failed: number }> {
    const counts = await this.queue.getJobCounts('waiting', 'active', 'delayed', 'failed');
    return {
      waiting: counts.waiting ?? 0,
      active: counts.active ?? 0,
      delayed: counts.delayed ?? 0,
      failed: counts.failed ?? 0,
    };
  }
  async ping(): Promise<void> {
    await this.queue.waitUntilReady();
    await this.connection.ping();
    if (this.worker && this.workerConnection) {
      await this.worker.waitUntilReady();
      await this.workerConnection.ping();
    }
  }
  async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await this.recovery;
    await this.worker?.close();
    await this.queue.close();
    if (this.workerConnection) await this.workerConnection.quit();
    await this.connection.quit();
  }
}
