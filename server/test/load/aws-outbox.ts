import { mkdir, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import { SQSClient } from '@aws-sdk/client-sqs';
import { sql } from 'kysely';
import { runner } from 'node-pg-migrate';
import { uuidV7 } from '../../src/common/ids/ids.js';
import { createDatabase } from '../../src/platform/database/database.js';
import { appendEvent } from '../../src/platform/outbox/outbox.js';
import { SqsEventQueue } from '../../src/platform/queue/sqs-event-queue.js';
import {
  SQS_LANES,
  SqsTransport,
  type SqsQueueUrls,
} from '../../src/platform/queue/sqs-transport.js';
import { startTestServices } from '../helpers/services.js';
import { createAwsTestQueues } from '../helpers/aws-test-queues.js';
import { outboxGatePasses, type OutboxResult } from './aws-outbox-gate.js';

/** This test owns an isolated database and temporary queues; never use application queues. */
async function main() {
  const profiles = {
    smoke: { seconds: 3, rate: 2, pauseMs: 1000 },
    local: { seconds: 300, rate: 20, pauseMs: 5000 },
  } as const;
  const name = process.env.LOAD_PROFILE as keyof typeof profiles;
  const profile = profiles[name];
  const region = process.env.AWS_REGION;
  const account = process.env.AWS_ACCOUNT_ID;
  if (
    process.env.AWS_P13_INTEGRATION !== 'yes' ||
    process.env.LOAD_ISOLATED_DATABASE !== 'yes' ||
    (name !== 'smoke' && name !== 'local') ||
    !region ||
    !account
  )
    throw new Error(
      'AWS integration opt-in, isolated database opt-in and load profile are required',
    );
  const poolMax = Number(process.env.LOAD_POOL_MAX ?? '20');
  if (!Number.isSafeInteger(poolMax) || poolMax < 1 || poolMax > 64)
    throw new Error('LOAD_POOL_MAX must be an integer from 1 to 64');

  const started = performance.now();
  const cpuStarted = process.cpuUsage();
  const report: Record<string, unknown> = {
    transport: 'sqs',
    profile: name,
    configured: { ...profile, poolMax, maxPendingWrites: 64, workerConcurrency: 4 },
    startedAt: new Date().toISOString(),
    resources: { cpus: os.cpus().length, memoryBytes: os.totalmem() },
    latencyDefinition:
      'event submission to completed consumer transaction; excludes events overlapping interruption and recovery',
    exitCode: 1,
  };
  const errors: string[] = [];
  let services: Awaited<ReturnType<typeof startTestServices>> | undefined;
  let queues: Awaited<ReturnType<typeof createAwsTestQueues>> | undefined;
  let db: ReturnType<typeof createDatabase> | undefined;
  let client: SQSClient | undefined;
  let worker: SqsEventQueue | undefined;
  let restart: Promise<void> | undefined;
  let generated = 0;
  let scheduled = 0;
  let maxPendingWrites = 0;
  let maxPoolWaiting = 0;
  let sampler: ReturnType<typeof setInterval> | undefined;
  const writes = new Set<Promise<void>>();
  try {
    services = await startTestServices({ skipAwsCache: true });
    if (!services.databaseIamUrl) throw new Error('IAM test database is required');
    await runner({
      databaseUrl: services.databaseUrl,
      dir: resolve('db/migrations'),
      direction: 'up',
      migrationsTable: 'pgmigrations',
      log: () => undefined,
    });
    queues = await createAwsTestQueues();
    client = new SQSClient({ region });
    const urls = Object.fromEntries(
      SQS_LANES.map((lane) => [
        lane,
        `https://sqs.${region}.amazonaws.com/${account}/${queues!.prefix}-${lane}`,
      ]),
    ) as SqsQueueUrls;
    const transport = new SqsTransport(client, urls, region, account, queues.prefix);
    db = createDatabase(services.databaseIamUrl, poolMax, 30000, undefined, 30000, region);
    const database = db.db;
    // Measure a warm steady-state pool separately from IAM/TLS connection setup.
    // Hold each checkout until every connection is ready, so the pool cannot reuse
    // one connection to satisfy the warm-up.
    let releasePool!: () => void;
    let signalReady!: () => void;
    const release = new Promise<void>((resolve) => {
      releasePool = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      signalReady = resolve;
    });
    let connected = 0;
    const warmers = Array.from({ length: poolMax }, () =>
      database.connection().execute(async (connection) => {
        await sql`SELECT 1`.execute(connection);
        connected++;
        if (connected === poolMax) signalReady();
        await release;
      }),
    );
    try {
      await Promise.race([
        ready,
        Promise.all(warmers),
        new Promise<never>((_resolve, reject) => {
          AbortSignal.timeout(60000).addEventListener(
            'abort',
            () => reject(new Error('database pool warm-up timed out')),
            { once: true },
          );
        }),
      ]);
    } finally {
      releasePool();
      await Promise.allSettled(warmers);
    }
    report.poolWarmup = { requested: poolMax, connected };
    const consumer = `p13-${randomUUID()}`;
    const startWorker = async () => {
      const queue = new SqsEventQueue({
        db: database,
        transport,
        concurrency: 4,
        onError: (error) => errors.push(error.message),
      });
      queue.registerHandler(consumer, async () => {});
      await queue.ping();
      queue.startRecovery(500);
      return queue;
    };
    worker = await startWorker();
    sampler = setInterval(() => {
      maxPoolWaiting = Math.max(maxPoolWaiting, db!.stats().waiting);
    }, 250);
    sampler.unref();
    const producerStart = performance.now();
    let pauseStart = 0;
    let pauseEnd = 0;
    let interruptedBacklog = 0;
    for (let i = 0; i < profile.seconds * profile.rate; i++) {
      const due = producerStart + (i * 1000) / profile.rate;
      const wait = due - performance.now();
      if (wait > 0) await delay(wait);
      if (performance.now() - due > 1000)
        throw new Error('producer did not sustain the target rate');
      if (i === Math.floor((profile.seconds * profile.rate) / 3)) {
        const stoppedWorker = worker!;
        worker = undefined;
        restart = (async () => {
          await stoppedWorker.close();
          pauseStart = Date.now();
          await delay(profile.pauseMs);
          const result = await sql<{
            count: string;
          }>`SELECT count(*)::text AS count FROM outbox_deliveries WHERE consumer=${consumer} AND completed_at IS NULL`.execute(
            database,
          );
          interruptedBacklog = Number(result.rows[0]?.count ?? 0);
          worker = await startWorker();
          pauseEnd = Date.now();
        })();
        // Attach a handler immediately; the error is still observed below.
        void restart.catch(() => undefined);
      }
      if (writes.size >= 64) throw new Error('producer database backlog exceeded its bound');
      const occurredAt = new Date().toISOString();
      const write = database
        .transaction()
        .execute(async (tx) =>
          appendEvent(
            tx,
            {
              eventId: uuidV7(),
              eventType: 'p13.load',
              schemaVersion: 1,
              aggregateType: 'p13',
              aggregateId: uuidV7(),
              aggregateVersion: '1',
              occurredAt,
              correlationId: consumer,
              causationId: null,
              payload: {},
            },
            [consumer],
          ),
        )
        .then(() => {
          generated++;
        })
        .catch(() => {
          errors.push('OUTBOX_PRODUCER_WRITE_FAILED');
        })
        .finally(() => writes.delete(write));
      writes.add(write);
      scheduled++;
      maxPendingWrites = Math.max(maxPendingWrites, writes.size);
    }
    await Promise.all(writes);
    await restart;
    const deadline = Date.now() + 120000;
    let result: OutboxResult | undefined;
    do {
      result = (
        await sql<
          typeof result
        >`SELECT count(*) FILTER(WHERE d.completed_at IS NOT NULL)::text AS completed,
        count(p.event_id)::text AS processed, count(*) FILTER(WHERE d.completed_at IS NULL)::text AS backlog,
        count(*) FILTER(WHERE d.suspended_at IS NOT NULL)::text AS suspended,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM (d.completed_at-e.occurred_at))*1000)
          FILTER (WHERE d.completed_at < ${new Date(pauseStart).toISOString()}::timestamptz OR e.occurred_at > ${new Date(pauseEnd + profile.pauseMs).toISOString()}::timestamptz) AS p50,
        percentile_cont(0.95) WITHIN GROUP (ORDER BY extract(epoch FROM (d.completed_at-e.occurred_at))*1000)
          FILTER (WHERE d.completed_at < ${new Date(pauseStart).toISOString()}::timestamptz OR e.occurred_at > ${new Date(pauseEnd + profile.pauseMs).toISOString()}::timestamptz) AS p95,
        percentile_cont(0.99) WITHIN GROUP (ORDER BY extract(epoch FROM (d.completed_at-e.occurred_at))*1000)
          FILTER (WHERE d.completed_at < ${new Date(pauseStart).toISOString()}::timestamptz OR e.occurred_at > ${new Date(pauseEnd + profile.pauseMs).toISOString()}::timestamptz) AS p99
        FROM outbox_events e JOIN outbox_deliveries d ON d.event_id=e.id
        LEFT JOIN processed_events p ON p.event_id=e.id AND p.consumer=d.consumer WHERE d.consumer=${consumer}`.execute(
          database,
        )
      ).rows[0];
      if (Number(result?.completed) === generated) break;
      await delay(500);
    } while (Date.now() < deadline);
    report.generated = generated;
    report.results = result;
    report.pause = { start: pauseStart, end: pauseEnd, interruptedBacklog };
    report.queueStats = worker?.stats();
    if (
      !outboxGatePasses({
        profile: name,
        expected: profile.seconds * profile.rate,
        generated,
        result,
        interruptedBacklog,
        errors,
      })
    )
      throw new Error('outbox latency, recovery or reconciliation threshold failed');
    report.exitCode = 0;
  } catch (error) {
    report.error = error instanceof Error ? error.message : 'unknown error';
  } finally {
    if (sampler) clearInterval(sampler);
    await Promise.all(writes);
    await restart?.catch(() => undefined);
    for (const close of [
      () => worker?.close(),
      () => db?.close(),
      () => queues?.close(),
      () => services?.stop(),
    ]) {
      try {
        await close();
      } catch (error) {
        errors.push(error instanceof Error ? error.message : 'cleanup failed');
        report.exitCode = 1;
      }
    }
    client?.destroy();
    report.generated = generated;
    report.producer = { scheduled, maxPendingWrites, maxPoolWaiting };
    report.errors = errors;
    report.endedAt = new Date().toISOString();
    report.elapsedMs = performance.now() - started;
    report.generatorCpuMicros = process.cpuUsage(cpuStarted);
    report.generatorMemoryBytes = process.memoryUsage();
    await mkdir('artifacts/p13-load', { recursive: true });
    const file = `artifacts/p13-load/aws-outbox-${name}-${Date.now()}.json`;
    await writeFile(file, JSON.stringify(report, null, 2));
    console.log(`Report: ${file}`);
    process.exitCode = Number(report.exitCode);
  }
}
void main();
