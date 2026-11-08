import { setTimeout as delay } from 'node:timers/promises';
import type { Database, Json } from '../database/database.js';
import { CONCERNS, type ConcernHandler, type QueueConcern, type Schedule } from './concerns.js';
import { SqsBatchWorker } from './sqs-batch-worker.js';
import { SqsConcernStore } from './sqs-concern-store.js';
import type { SqsJobPointer, SqsTransport } from './sqs-transport.js';

/** Durable concern jobs and schedules in Aurora, with SQS used only as delivery hints. */
export class SqsConcernQueues {
  private readonly store: SqsConcernStore;
  private readonly handlers = new Map<string, ConcernHandler>();
  private readonly workers = new Map<QueueConcern, Promise<void>>();
  private readonly abort = new AbortController();
  private readonly timer?: ReturnType<typeof setInterval>;
  private readonly onError: (error: Error) => void;
  private relay?: Promise<void>;
  private readonly batchSize: number;

  constructor(
    private readonly options: {
      db: Database;
      transport: SqsTransport;
      consume?: boolean;
      concurrency?: number;
      onError?: (error: Error) => void;
    },
  ) {
    if (
      !Number.isSafeInteger(options.concurrency ?? 4) ||
      (options.concurrency ?? 4) < 1 ||
      (options.concurrency ?? 4) > 100
    )
      throw new Error('INVALID_CONCERN_QUEUE_CONFIGURATION');
    this.store = new SqsConcernStore(options.db);
    this.batchSize = Math.min(10, options.concurrency ?? 4);
    this.onError = options.onError ?? (() => undefined);
    if (options.consume !== false) {
      this.timer = setInterval(() => this.kickRelay(), 1000);
      this.timer.unref();
    }
  }

  register(concern: QueueConcern, name: string, handler: ConcernHandler): void {
    if (!CONCERNS.includes(concern) || !/^[a-z][a-z0-9_-]{0,63}$/.test(name))
      throw new Error('INVALID_CONCERN_JOB');
    const key = `${concern}/${name}`;
    if (this.options.consume === false || this.handlers.has(key))
      throw new Error('INVALID_OR_DUPLICATE_CONCERN_HANDLER');
    this.handlers.set(key, handler);
    if (!this.workers.has(concern)) this.workers.set(concern, this.poll(concern));
  }

  async enqueue(
    concern: QueueConcern,
    name: string,
    data: Json,
    operationId: string,
  ): Promise<void> {
    await this.store.enqueue(concern, name, data, operationId);
    if (this.options.consume !== false) this.kickRelay();
  }

  async upsertScheduler(
    concern: QueueConcern,
    schedulerId: string,
    name: string,
    data: Json,
    schedule: Schedule,
  ): Promise<void> {
    await this.store.upsertScheduler(concern, schedulerId, name, data, schedule);
  }

  private kickRelay(): void {
    if (this.relay || this.abort.signal.aborted) return;
    this.relay = this.relayOnce()
      .catch(() => this.onError(new Error('SQS_CONCERN_RELAY_FAILED')))
      .finally(() => {
        this.relay = undefined;
      });
  }

  async relayOnce(): Promise<void> {
    await this.store.tickSchedules();
    const claimed = await this.store.claimDue();
    for (let i = 0; i < claimed.length; i++) {
      const job = claimed[i]!;
      try {
        await this.options.transport.send(job.concern, job.pointer);
        await this.store.sent(job);
      } catch {
        for (const pending of claimed.slice(i)) await this.store.sendFailed(pending);
        throw new Error('SQS_CONCERN_RELAY_FAILED');
      }
    }
  }

  private async poll(concern: QueueConcern): Promise<void> {
    const worker = new SqsBatchWorker(
      this.options.transport,
      (pointer) => this.process(concern, pointer),
      this.onError,
      this.batchSize,
    );
    while (!this.abort.signal.aborted) {
      try {
        await worker.runOnce(concern, this.abort.signal);
      } catch {
        if (!this.abort.signal.aborted) {
          this.onError(new Error('SQS_CONCERN_POLL_FAILED'));
          await delay(1000);
        }
      }
    }
  }

  private async process(concern: QueueConcern, pointer: SqsJobPointer): Promise<void> {
    const claim = await this.store.acquire(concern, pointer);
    if (claim.kind === 'terminal') return;
    if (claim.kind !== 'claimed') throw new Error('CONCERN_JOB_UNAVAILABLE');
    const handler = this.handlers.get(`${concern}/${claim.job.name}`);
    if (!handler) {
      await this.store.fail(concern, pointer, claim.job.token);
      throw new Error('CONCERN_HANDLER_UNAVAILABLE');
    }
    let heartbeat: Promise<void> | undefined;
    let lost = false;
    const timer = setInterval(() => {
      if (heartbeat) return;
      heartbeat = this.store
        .heartbeat(concern, pointer, claim.job.token)
        .then((ok) => {
          if (!ok) lost = true;
        })
        .catch(() => {
          lost = true;
        })
        .finally(() => {
          heartbeat = undefined;
        });
    }, 40000);
    timer.unref();
    try {
      await handler(claim.job.payload, pointer.jobId);
      clearInterval(timer);
      await heartbeat;
      if (lost || !(await this.store.finish(concern, pointer, claim.job.token)))
        throw new Error('CONCERN_LEASE_LOST');
    } catch (error) {
      clearInterval(timer);
      await heartbeat;
      if (!lost) await this.store.fail(concern, pointer, claim.job.token);
      throw error;
    } finally {
      clearInterval(timer);
    }
  }

  listFailed(concern: QueueConcern, limit?: number) {
    return this.store.listFailed(concern, limit);
  }
  getFailed(concern: QueueConcern, id: string) {
    return this.store.getFailed(concern, id);
  }
  replay(concern: QueueConcern, id: string) {
    return this.store.replay(concern, id);
  }
  depths() {
    return this.store.depths();
  }
  async ping(): Promise<void> {
    await Promise.all(CONCERNS.map((concern) => this.options.transport.ping(concern)));
  }
  async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.abort.abort();
    await Promise.allSettled([...this.workers.values()]);
    await this.relay;
  }
}
