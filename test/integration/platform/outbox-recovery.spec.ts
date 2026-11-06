import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { resolve } from 'node:path';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { sql } from 'kysely';
import { runner } from 'node-pg-migrate';
import { uuidV7 } from '../../../src/common/ids/ids.js';
import { hashRequest, IdempotencyStore } from '../../../src/common/idempotency/idempotency.js';
import { createDatabase, type DatabaseHandle } from '../../../src/platform/database/database.js';
import { appendEvent, OutboxStore } from '../../../src/platform/outbox/outbox.js';
import { consumeOnce } from '../../../src/platform/events/consume.js';
import { DurableQueue } from '../../../src/platform/queue/queue.js';
import { startTestServices, type TestServices } from '../../helpers/services.js';

let services: TestServices;
let handle: DatabaseHandle;
beforeAll(async () => {
  services = await startTestServices();
  await runner({
    databaseUrl: services.databaseUrl,
    dir: resolve('db/migrations'),
    direction: 'up',
    migrationsTable: 'pgmigrations',
  });
  handle = createDatabase(services.databaseUrl);
  await sql`CREATE TABLE test_aggregates(id uuid PRIMARY KEY, version int NOT NULL, effects int NOT NULL DEFAULT 0)`.execute(
    handle.db,
  );
  await sql`CREATE TABLE test_history(aggregate_id uuid NOT NULL, version int NOT NULL, PRIMARY KEY (aggregate_id,version))`.execute(
    handle.db,
  );
}, 120_000);
afterAll(async () => {
  await handle?.close();
  await services?.stop();
}, 120_000);

async function eventually(predicate: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(50);
  }
  throw new Error('Timed out waiting for durable effect');
}

async function createMutation(): Promise<{ aggregateId: string; eventId: string }> {
  const aggregateId = uuidV7();
  const eventId = uuidV7();
  const scope = {
    actor: 'test-user',
    audience: 'test',
    method: 'POST',
    resource: '/test',
    key: uuidV7(),
  };
  const store = new IdempotencyStore(handle.db);
  const claim = await store.claim(scope, hashRequest('{}'));
  if (claim.kind !== 'claimed') throw new Error('Expected claim');
  await store.execute(claim.owner, async (tx) => {
    await sql`INSERT INTO test_aggregates(id,version) VALUES (${aggregateId}::uuid,1)`.execute(tx);
    await sql`INSERT INTO test_history(aggregate_id,version) VALUES (${aggregateId}::uuid,1)`.execute(
      tx,
    );
    await appendEvent(
      tx,
      {
        eventId,
        eventType: 'test.mutated',
        schemaVersion: 1,
        aggregateType: 'test',
        aggregateId,
        aggregateVersion: '1',
        occurredAt: '2026-01-01T00:00:00.000Z',
        correlationId: 'test',
        causationId: null,
        payload: { aggregateId },
      },
      ['test-consumer'],
    );
    return { status: 201, body: { aggregateId } };
  });
  return { aggregateId, eventId };
}

describe('transactional outbox recovery with real PostgreSQL and Redis', () => {
  it('waits for an in-flight recovery before closing its queue', async () => {
    const durable = new DurableQueue({
      db: handle.db,
      redisUrl: services.redisUrl,
      prefix: services.redisPrefix,
      consume: false,
    });
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started = false;
    durable.recoverOnce = async () => {
      started = true;
      await blocked;
      return 0;
    };
    durable.startRecovery(100);
    let closed = false;
    try {
      await eventually(async () => started);
      const closing = durable.close().then(() => {
        closed = true;
      });
      await delay(50);
      expect(closed).toBe(false);
      release();
      await closing;
      expect(closed).toBe(true);
    } finally {
      release();
      if (!closed) await durable.close();
    }
  });

  it('recovers publish-before-ack crash, then applies DB effect once', async () => {
    const { aggregateId, eventId } = await createMutation();
    const outbox = new OutboxStore(handle.db);
    const claimed = await outbox.claim();
    expect(claimed).toHaveLength(1);
    const connection = new Redis(services.redisUrl, { maxRetriesPerRequest: null });
    const queue = new Queue('platform-events', { connection, prefix: services.redisPrefix });
    const suffix = createHash('sha256').update('test-consumer').digest('hex').slice(0, 16);
    try {
      await queue.add(
        'delivery',
        { eventId, consumer: 'test-consumer' },
        { jobId: `${eventId}-${suffix}`, removeOnComplete: true, removeOnFail: true },
      );
      // Simulate process death after Redis accepted publication but before DB acknowledgement.
      await sql`UPDATE outbox_deliveries SET lease_until=clock_timestamp()-interval '1 second' WHERE event_id=${eventId}::uuid`.execute(
        handle.db,
      );
      const reclaimed = await outbox.claim();
      expect(reclaimed).toHaveLength(1);
      await queue.add(
        'delivery',
        { eventId, consumer: 'test-consumer' },
        { jobId: `${eventId}-${suffix}`, removeOnComplete: true, removeOnFail: true },
      );
      await outbox.acknowledge(reclaimed[0]!);
      const effect = async (tx: Parameters<Parameters<typeof consumeOnce>[3]>[0]) => {
        await sql`UPDATE test_aggregates SET effects=effects+1 WHERE id=${aggregateId}::uuid`.execute(
          tx,
        );
      };
      expect(await consumeOnce(handle.db, eventId, 'test-consumer', effect)).toBe(true);
      expect(await consumeOnce(handle.db, eventId, 'test-consumer', effect)).toBe(false);
      const result = await sql<{
        effects: number;
        history: string;
      }>`SELECT effects,(SELECT count(*)::text FROM test_history WHERE aggregate_id=${aggregateId}::uuid) AS history FROM test_aggregates WHERE id=${aggregateId}::uuid`.execute(
        handle.db,
      );
      expect(result.rows[0]).toEqual({ effects: 1, history: '1' });
    } finally {
      await queue.obliterate({ force: true });
      await queue.close();
      await connection.quit();
    }
  });

  it('recreates a lost Redis job even after successful enqueue acknowledgement', async () => {
    const { aggregateId, eventId } = await createMutation();
    const outbox = new OutboxStore(handle.db);
    const claim = (await outbox.claim())[0]!;
    const connection = new Redis(services.redisUrl, { maxRetriesPerRequest: null });
    const queue = new Queue('platform-events', { connection, prefix: services.redisPrefix });
    const suffix = createHash('sha256').update('test-consumer').digest('hex').slice(0, 16);
    const job = await queue.add(
      'delivery',
      { eventId, consumer: 'test-consumer' },
      { jobId: `${eventId}-${suffix}`, removeOnComplete: true, removeOnFail: true },
    );
    await outbox.acknowledge(claim);
    await job.remove(); // Redis lost the job after acknowledgement.
    await queue.close();
    await connection.quit();
    await sql`UPDATE outbox_deliveries SET next_publish_at=clock_timestamp()-interval '1 second' WHERE event_id=${eventId}::uuid`.execute(
      handle.db,
    );
    const durable = new DurableQueue({
      db: handle.db,
      redisUrl: services.redisUrl,
      prefix: services.redisPrefix,
      handlers: {
        'test-consumer': async (tx) => {
          await sql`UPDATE test_aggregates SET effects=effects+1 WHERE id=${aggregateId}::uuid`.execute(
            tx,
          );
        },
      },
    });
    try {
      await durable.ping();
      expect(await durable.recoverOnce()).toBe(1);
      await eventually(
        async () =>
          (
            await sql<{
              effects: number;
            }>`SELECT effects FROM test_aggregates WHERE id=${aggregateId}::uuid`.execute(handle.db)
          ).rows[0]?.effects === 1,
      );
      const state = await sql<{
        completed: boolean;
        processed: string;
      }>`SELECT d.completed_at IS NOT NULL AS completed,(SELECT count(*)::text FROM processed_events p WHERE p.event_id=d.event_id) AS processed FROM outbox_deliveries d WHERE d.event_id=${eventId}::uuid`.execute(
        handle.db,
      );
      expect(state.rows[0]).toEqual({ completed: true, processed: '1' });
    } finally {
      await durable.close();
    }
  });

  it('suspends an unregistered consumer after its bounded attempt budget', async () => {
    const { aggregateId, eventId } = await createMutation();
    const durable = new DurableQueue({
      db: handle.db,
      redisUrl: services.redisUrl,
      prefix: services.redisPrefix,
      maxAttempts: 1,
    });
    try {
      await durable.ping();
      expect(await durable.recoverOnce()).toBe(1);
      await eventually(
        async () =>
          (
            await sql<{
              suspended: boolean;
            }>`SELECT suspended_at IS NOT NULL AS suspended FROM outbox_deliveries WHERE event_id=${eventId}::uuid`.execute(
              handle.db,
            )
          ).rows[0]?.suspended === true,
      );
      const result = await sql<{
        attempts: number;
        complete: boolean;
      }>`SELECT processing_attempts AS attempts, completed_at IS NOT NULL AS complete FROM outbox_deliveries WHERE event_id=${eventId}::uuid`.execute(
        handle.db,
      );
      expect(result.rows[0]).toEqual({ attempts: 1, complete: false });
      expect(
        (await durable.outbox.listFailed()).some((delivery) => delivery.eventId === eventId),
      ).toBe(true);
      const connection = new Redis(services.redisUrl, { maxRetriesPerRequest: null });
      const queue = new Queue('platform-events', { connection, prefix: services.redisPrefix });
      try {
        const suffix = createHash('sha256').update('test-consumer').digest('hex').slice(0, 16);
        await eventually(async () => !(await queue.getJob(`${eventId}-${suffix}`)));
      } finally {
        await queue.close();
        await connection.quit();
      }
      durable.registerHandler('test-consumer', async (tx) => {
        await sql`UPDATE test_aggregates SET effects=effects+1 WHERE id=${aggregateId}::uuid`.execute(
          tx,
        );
      });
      await durable.outbox.replay(eventId, 'test-consumer');
      expect(await durable.recoverOnce()).toBe(1);
      await eventually(
        async () =>
          (
            await sql<{
              effects: number;
            }>`SELECT effects FROM test_aggregates WHERE id=${aggregateId}::uuid`.execute(handle.db)
          ).rows[0]?.effects === 1,
      );
      expect(
        (await durable.outbox.listFailed()).some((delivery) => delivery.eventId === eventId),
      ).toBe(false);
    } finally {
      await durable.close();
    }
  });

  it('keeps fan-out obligations independent and fences a stale enqueue acknowledgement', async () => {
    const aggregateId = uuidV7();
    const eventId = uuidV7();
    await handle.db.transaction().execute(async (tx) => {
      await sql`INSERT INTO test_aggregates(id,version) VALUES (${aggregateId}::uuid,1)`.execute(
        tx,
      );
      await appendEvent(
        tx,
        {
          eventId,
          eventType: 'test.fanout',
          schemaVersion: 1,
          aggregateType: 'test',
          aggregateId,
          aggregateVersion: '1',
          occurredAt: '2026-01-01T00:00:00.000Z',
          correlationId: 'test',
          causationId: null,
          payload: {},
        },
        ['first', 'second'],
      );
    });
    const outbox = new OutboxStore(handle.db);
    const deliveries = await outbox.claim();
    expect(deliveries).toHaveLength(2);
    const first = deliveries.find((delivery) => delivery.consumer === 'first')!;
    const second = deliveries.find((delivery) => delivery.consumer === 'second')!;
    await outbox.fail(first);
    await outbox.acknowledge(second);
    const effect = async (tx: Parameters<Parameters<typeof consumeOnce>[3]>[0]) => {
      await sql`UPDATE test_aggregates SET effects=effects+1 WHERE id=${aggregateId}::uuid`.execute(
        tx,
      );
    };
    expect(await consumeOnce(handle.db, eventId, 'second', effect)).toBe(true);
    await sql`UPDATE outbox_deliveries SET next_publish_at=clock_timestamp()-interval '1 second' WHERE event_id=${eventId}::uuid AND consumer='first'`.execute(
      handle.db,
    );
    const retry = (await outbox.claim())[0]!;
    expect(retry.consumer).toBe('first');
    expect(await outbox.acknowledge(first)).toBe(false);
    expect(await outbox.acknowledge(retry)).toBe(true);
    expect(await consumeOnce(handle.db, eventId, 'first', effect)).toBe(true);
    expect(await consumeOnce(handle.db, eventId, 'first', effect)).toBe(false);
    const result = await sql<{
      effects: number;
    }>`SELECT effects FROM test_aggregates WHERE id=${aggregateId}::uuid`.execute(handle.db);
    expect(result.rows[0]?.effects).toBe(2);
  });

  it('rolls back an event and aggregate mutation together', async () => {
    const aggregateId = uuidV7();
    const eventId = uuidV7();
    await expect(
      handle.db.transaction().execute(async (tx) => {
        await sql`INSERT INTO test_aggregates(id,version) VALUES (${aggregateId}::uuid,1)`.execute(
          tx,
        );
        await appendEvent(
          tx,
          {
            eventId,
            eventType: 'test.rollback',
            schemaVersion: 1,
            aggregateType: 'test',
            aggregateId,
            aggregateVersion: '1',
            occurredAt: '2026-01-01T00:00:00.000Z',
            correlationId: 'test',
            causationId: null,
            payload: {},
          },
          [],
        );
        throw new Error('abort');
      }),
    ).rejects.toThrow('abort');
    const result = await sql<{
      events: string;
      aggregates: string;
    }>`SELECT (SELECT count(*)::text FROM outbox_events WHERE id=${eventId}::uuid) AS events,(SELECT count(*)::text FROM test_aggregates WHERE id=${aggregateId}::uuid) AS aggregates`.execute(
      handle.db,
    );
    expect(result.rows[0]).toEqual({ events: '0', aggregates: '0' });
  });
});
