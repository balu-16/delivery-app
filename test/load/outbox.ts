import { mkdir, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';
import os from 'node:os';
import { sql } from 'kysely';
import { uuidV7 } from '../../src/common/ids/ids.js';
import { createDatabase } from '../../src/platform/database/database.js';
import { appendEvent } from '../../src/platform/outbox/outbox.js';
import { DurableQueue } from '../../src/platform/queue/queue.js';

// Isolated DB mandatory: the production relay claims every due consumer.
async function main() {
  const profiles = {
    smoke: { seconds: 3, rate: 2, pauseMs: 1000 },
    local: { seconds: 300, rate: 20, pauseMs: 5000 },
  } as const;
  const name = process.env.LOAD_PROFILE as keyof typeof profiles,
    p = profiles[name];
  const url = process.env.DATABASE_URL,
    redis = process.env.REDIS_URL;
  if (!p || !url || !redis || process.env.LOAD_ISOLATED_DATABASE !== 'yes')
    throw new Error('Profile, URLs and LOAD_ISOLATED_DATABASE=yes required');
  const setting = (key: string, fallback: number, min: number, max: number) => {
    const value = Number(process.env[key] ?? fallback);
    if (!Number.isSafeInteger(value) || value < min || value > max)
      throw new Error(`Invalid ${key}`);
    return value;
  };
  const concurrency = setting('QUEUE_CONCURRENCY', 4, 1, 100);
  const pollIntervalMs = setting('OUTBOX_POLL_INTERVAL_MS', 500, 100, 60000);
  const db = createDatabase(url, 20),
    runId = uuidV7(),
    consumer = `p13-${runId}`,
    output = process.env.LOAD_OUTPUT_DIR ?? 'artifacts/p13-load';
  await mkdir(output, { recursive: true });
  const file = `${output}/outbox-${name}-${Date.now()}.json`;
  const report: Record<string, unknown> = {
    profile: name,
    configured: { ...p, concurrency, pollIntervalMs },
    latencyDefinition:
      'event timestamp before append transaction commit to completed consumer transaction; includes commit delay and excludes interruption and recovery window',
    consumerEffect: 'empty handler; measures durable queue transaction completion',
    startedAt: new Date().toISOString(),
    resources: { host: os.hostname(), cpus: os.cpus().length, memoryBytes: os.totalmem() },
    generated: 0,
    errors: [],
    exitCode: 1,
  };
  const errors: string[] = [],
    started = performance.now(),
    ids: string[] = [];
  let queue: DurableQueue | undefined;
  const startQueue = async () => {
    const q = new DurableQueue({
      db: db.db,
      redisUrl: redis,
      prefix: `p13-${runId}`,
      concurrency,
      handlers: { [consumer]: async () => {} },
      onError: (error) => errors.push(error.message),
    });
    await q.ping();
    q.startRecovery(pollIntervalMs);
    return q;
  };
  let pauseStart = 0,
    pauseEnd = 0,
    interruptedBacklog = 0;
  try {
    const pending = await sql<{
      count: string;
    }>`SELECT count(*)::text AS count FROM outbox_deliveries WHERE completed_at IS NULL`.execute(
      db.db,
    );
    if (pending.rows[0]?.count !== '0')
      throw new Error('Dedicated database has existing incomplete outbox obligations');
    queue = await startQueue();
    const producerStart = performance.now();
    for (let i = 0; i < p.seconds * p.rate; i++) {
      const due = producerStart + (i * 1000) / p.rate,
        wait = due - performance.now();
      if (wait > 0) await delay(wait);
      if (performance.now() - due > 1000)
        throw new Error('producer failed to sustain requested event rate');
      if (i === Math.floor((p.seconds * p.rate) / 3)) {
        pauseStart = Date.now();
        report.beforeInterruptionStats = queue!.stats();
        await queue!.close();
        queue = undefined;
        // Restart asynchronously, while production continues to build a real backlog.
        void delay(p.pauseMs)
          .then(async () => {
            const result = await sql<{
              count: string;
            }>`SELECT count(*)::text AS count FROM outbox_deliveries WHERE consumer=${consumer} AND completed_at IS NULL`.execute(
              db.db,
            );
            interruptedBacklog = Number(result.rows[0]?.count ?? 0);
            queue = await startQueue();
            pauseEnd = Date.now();
            report.afterRestartStats = queue.stats();
          })
          .catch((e: unknown) => errors.push(String(e)));
      }
      const eventId = uuidV7();
      ids.push(eventId);
      await db.db.transaction().execute(async (tx) =>
        appendEvent(
          tx,
          {
            eventId,
            eventType: 'p13.load',
            schemaVersion: 1,
            aggregateType: 'p13',
            aggregateId: uuidV7(),
            aggregateVersion: '1',
            occurredAt: new Date().toISOString(),
            correlationId: runId,
            causationId: null,
            payload: {},
          },
          [consumer],
        ),
      );
    }
    const deadline = Date.now() + 30000;
    while (!pauseEnd && Date.now() < deadline) await delay(100);
    if (!pauseEnd) throw new Error('interrupted worker did not restart');
    let rows:
      | {
          completed: string;
          processed: string;
          suspended: string;
          p50: number | null;
          p95: number | null;
          p99: number | null;
          backlog: string;
        }
      | undefined;
    do {
      rows = (
        await sql<
          typeof rows
        >`SELECT count(*) FILTER(WHERE d.completed_at IS NOT NULL)::text AS completed, count(p.event_id)::text AS processed, count(*) FILTER(WHERE d.suspended_at IS NOT NULL)::text AS suspended, count(*) FILTER(WHERE d.completed_at IS NULL)::text AS backlog,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM (d.completed_at-e.occurred_at))*1000) FILTER (WHERE e.occurred_at < ${new Date(pauseStart).toISOString()}::timestamptz OR e.occurred_at > ${new Date(pauseEnd + p.pauseMs).toISOString()}::timestamptz) AS p50,
        percentile_cont(0.95) WITHIN GROUP (ORDER BY extract(epoch FROM (d.completed_at-e.occurred_at))*1000) FILTER (WHERE e.occurred_at < ${new Date(pauseStart).toISOString()}::timestamptz OR e.occurred_at > ${new Date(pauseEnd + p.pauseMs).toISOString()}::timestamptz) AS p95,
        percentile_cont(0.99) WITHIN GROUP (ORDER BY extract(epoch FROM (d.completed_at-e.occurred_at))*1000) FILTER (WHERE e.occurred_at < ${new Date(pauseStart).toISOString()}::timestamptz OR e.occurred_at > ${new Date(pauseEnd + p.pauseMs).toISOString()}::timestamptz) AS p99
        FROM outbox_events e JOIN outbox_deliveries d ON d.event_id=e.id LEFT JOIN processed_events p ON p.event_id=e.id AND p.consumer=d.consumer WHERE d.consumer=${consumer}`.execute(
          db.db,
        )
      ).rows[0];
      if (Number(rows?.completed) === ids.length) break;
      await delay(100);
    } while (Date.now() < deadline);
    report.generated = ids.length;
    report.results = rows;
    report.pause = {
      start: pauseStart,
      end: pauseEnd,
      interruptedBacklog,
      healthyResumeAfter: pauseEnd + p.pauseMs,
    };
    report.queueStats = queue?.stats();
    if (
      !rows ||
      Number(rows.completed) !== p.rate * p.seconds ||
      rows.completed !== rows.processed ||
      rows.backlog !== '0' ||
      rows.suspended !== '0' ||
      rows.p95 === null ||
      rows.p95 > 2000 ||
      interruptedBacklog < 1 ||
      errors.length
    )
      throw new Error('outbox threshold or invariant failed');
    report.exitCode = 0;
  } catch (error) {
    report.error = error instanceof Error ? error.message : String(error);
  } finally {
    await queue?.close();
    await db.close();
    report.errors = errors;
    report.endedAt = new Date().toISOString();
    report.elapsedMs = performance.now() - started;
    await writeFile(file, JSON.stringify(report, null, 2));
    console.log(`Report: ${file}`);
    process.exitCode = Number(report.exitCode);
  }
}
void main();
