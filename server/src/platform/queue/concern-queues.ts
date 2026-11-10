import { createHash } from 'node:crypto';
import { Queue, Worker, type JobsOptions } from 'bullmq';
import { Redis } from 'ioredis';
import type { Json } from '../database/database.js';
import {
  CONCERNS,
  type QueueConcern,
  type ConcernHandler,
  type Schedule,
  type FailedConcernJob,
} from './concerns.js';
export { CONCERNS } from './concerns.js';
export type { QueueConcern, ConcernHandler, Schedule, FailedConcernJob } from './concerns.js';
export interface ConcernQueueOptions {
  redisUrl: string;
  prefix?: string;
  concurrency?: number;
  attempts?: number;
  retryDelayMs?: number;
  consume?: boolean;
  onError?: (error: Error) => void;
}
/** Redis transports jobs; business handlers must use durable operation IDs and idempotent effects. */
export class ConcernQueues {
  private readonly connection: Redis;
  private readonly queues = new Map<QueueConcern, Queue<Json>>();
  private readonly workers = new Map<QueueConcern, Worker<Json>>();
  private readonly workerConnections = new Map<QueueConcern, Redis>();
  private readonly handlers = new Map<string, ConcernHandler>();
  private readonly options: Required<Omit<ConcernQueueOptions, 'prefix' | 'redisUrl'>>;
  private readonly jobOptions: JobsOptions;
  constructor(private readonly config: ConcernQueueOptions) {
    this.options = {
      concurrency: config.concurrency ?? 4,
      attempts: config.attempts ?? 5,
      retryDelayMs: config.retryDelayMs ?? 1000,
      consume: config.consume ?? true,
      onError: config.onError ?? (() => undefined),
    };
    if (
      !config.redisUrl ||
      !Number.isSafeInteger(this.options.concurrency) ||
      this.options.concurrency < 1 ||
      this.options.concurrency > 100 ||
      !Number.isSafeInteger(this.options.attempts) ||
      this.options.attempts < 1 ||
      this.options.attempts > 100 ||
      !Number.isSafeInteger(this.options.retryDelayMs) ||
      this.options.retryDelayMs < 1 ||
      this.options.retryDelayMs > 60000
    )
      throw new Error('INVALID_CONCERN_QUEUE_CONFIGURATION');
    this.jobOptions = {
      attempts: this.options.attempts,
      backoff: { type: 'exponential', delay: this.options.retryDelayMs, jitter: 0.5 },
      removeOnComplete: true,
      removeOnFail: { count: 1000 },
    };
    this.connection = new Redis(config.redisUrl, {
      maxRetriesPerRequest: null,
      connectTimeout: 5000,
      commandTimeout: 5000,
    });
    this.connection.on('error', this.options.onError);
  }
  private queue(concern: QueueConcern): Queue<Json> {
    if (!CONCERNS.includes(concern)) throw new Error('INVALID_QUEUE_CONCERN');
    let queue = this.queues.get(concern);
    if (!queue) {
      queue = new Queue<Json>(concern, {
        connection: this.connection,
        prefix: this.config.prefix ?? 'delivery',
      });
      queue.on('error', this.options.onError);
      this.queues.set(concern, queue);
    }
    return queue;
  }
  private key(concern: QueueConcern, name: string): string {
    if (!CONCERNS.includes(concern) || !/^[a-z][a-z0-9_-]{0,63}$/.test(name))
      throw new Error('INVALID_CONCERN_JOB');
    return `${concern}/${name}`;
  }
  register(concern: QueueConcern, name: string, handler: ConcernHandler): void {
    const key = this.key(concern, name);
    if (!this.options.consume || this.handlers.has(key))
      throw new Error('INVALID_OR_DUPLICATE_CONCERN_HANDLER');
    this.handlers.set(key, handler);
    if (this.workers.has(concern)) return;
    const connection = new Redis(this.config.redisUrl, {
      maxRetriesPerRequest: null,
      connectTimeout: 5000,
    });
    connection.on('error', this.options.onError);
    const worker = new Worker<Json>(
      concern,
      async (job) => {
        const registered = this.handlers.get(this.key(concern, job.name));
        if (!registered || !job.id) throw new Error('CONCERN_HANDLER_UNAVAILABLE');
        await registered(job.data, job.id);
      },
      {
        connection,
        prefix: this.config.prefix ?? 'delivery',
        concurrency: this.options.concurrency,
      },
    );
    worker.on('error', this.options.onError);
    this.workers.set(concern, worker);
    this.workerConnections.set(concern, connection);
  }
  async enqueue(
    concern: QueueConcern,
    name: string,
    data: Json,
    operationId: string,
  ): Promise<void> {
    this.key(concern, name);
    if (!operationId || operationId.length > 512) throw new Error('INVALID_OPERATION_ID');
    const digest = createHash('sha256').update(`${name}\0${operationId}`).digest('hex');
    await this.queue(concern).add(name, data, { ...this.jobOptions, jobId: digest });
  }
  async upsertScheduler(
    concern: QueueConcern,
    schedulerId: string,
    name: string,
    data: Json,
    schedule: Schedule,
  ): Promise<void> {
    this.key(concern, name);
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(schedulerId)) throw new Error('INVALID_SCHEDULER_ID');
    if (
      'everyMs' in schedule &&
      (!Number.isSafeInteger(schedule.everyMs) ||
        schedule.everyMs < 100 ||
        schedule.everyMs > 31536000000)
    )
      throw new Error('INVALID_SCHEDULE');
    if ('pattern' in schedule && (!schedule.pattern || schedule.pattern.length > 128))
      throw new Error('INVALID_SCHEDULE');
    const repeat =
      'everyMs' in schedule
        ? { every: schedule.everyMs }
        : { pattern: schedule.pattern, tz: 'Asia/Kolkata' };
    await this.queue(concern).upsertJobScheduler(schedulerId, repeat, {
      name,
      data,
      opts: this.jobOptions,
    });
  }
  async listFailed(concern: QueueConcern, limit = 50): Promise<FailedConcernJob[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500)
      throw new Error('INVALID_FAILED_JOB_LIMIT');
    const jobs = await this.queue(concern).getFailed(0, limit - 1);
    return jobs.map((job) => ({
      id: job.id ?? '',
      name: job.name,
      attempts: job.attemptsMade,
      failedAt: job.finishedOn,
    }));
  }
  async getFailed(concern: QueueConcern, id: string): Promise<FailedConcernJob | null> {
    const job = await this.queue(concern).getJob(id);
    if (!job || (await job.getState()) !== 'failed') return null;
    return {
      id: job.id ?? '',
      name: job.name,
      attempts: job.attemptsMade,
      failedAt: job.finishedOn,
    };
  }
  async replay(concern: QueueConcern, id: string): Promise<void> {
    const job = await this.queue(concern).getJob(id);
    if (!job || (await job.getState()) !== 'failed') throw new Error('FAILED_JOB_NOT_FOUND');
    await job.retry('failed', { resetAttemptsMade: true, resetAttemptsStarted: true });
  }
  async depths(): Promise<
    Array<{
      concern: QueueConcern;
      waiting: number;
      active: number;
      delayed: number;
      failed: number;
    }>
  > {
    return Promise.all(
      CONCERNS.map(async (concern) => {
        const counts = await this.queue(concern).getJobCounts(
          'waiting',
          'active',
          'delayed',
          'failed',
        );
        return {
          concern,
          waiting: counts.waiting ?? 0,
          active: counts.active ?? 0,
          delayed: counts.delayed ?? 0,
          failed: counts.failed ?? 0,
        };
      }),
    );
  }
  async ping(): Promise<void> {
    await this.connection.ping();
  }
  async close(): Promise<void> {
    await Promise.all([...this.workers.values()].map((worker) => worker.close()));
    await Promise.all([...this.queues.values()].map((queue) => queue.close()));
    await Promise.all([...this.workerConnections.values()].map((connection) => connection.quit()));
    await this.connection.quit();
  }
}
