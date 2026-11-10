import { setTimeout as delay } from 'node:timers/promises';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { sql } from 'kysely';
import { createApplication } from '../../../src/bootstrap.js';
import { uuidV7 } from '../../../src/common/ids/ids.js';
import { readEnv } from '../../../src/config/env.schema.js';
import { PLATFORM_QUEUE } from '../../../src/platform/contracts/runtime.js';
import { appendEvent } from '../../../src/platform/outbox/outbox.js';
import { runtimeQueuePrefix } from '../../../src/platform/platform.module.js';
import type { DurableQueue } from '../../../src/platform/queue/queue.js';
import { createDatabase, type DatabaseHandle } from '../../../src/platform/database/database.js';
import { startTestServices, type TestServices } from '../../helpers/services.js';

it('isolates two application queues for distinct test databases on the same Redis server', async () => {
  const first = await startTestServices();
  let second: TestServices | undefined;
  let appA: NestFastifyApplication | undefined;
  let appB: NestFastifyApplication | undefined;
  let dbA: DatabaseHandle | undefined;
  let dbB: DatabaseHandle | undefined;
  try {
    // Reuse the first isolated server pair for a second, separately created database.
    const previousDatabase = process.env.TEST_DATABASE_URL;
    const previousRedis = process.env.TEST_REDIS_URL;
    try {
      process.env.TEST_DATABASE_URL = first.databaseUrl;
      process.env.TEST_REDIS_URL = first.redisUrl;
      second = await startTestServices();
    } finally {
      if (previousDatabase === undefined) delete process.env.TEST_DATABASE_URL;
      else process.env.TEST_DATABASE_URL = previousDatabase;
      if (previousRedis === undefined) delete process.env.TEST_REDIS_URL;
      else process.env.TEST_REDIS_URL = previousRedis;
    }
    const { runner } = await import('node-pg-migrate');
    for (const services of [first, second])
      await runner({
        databaseUrl: services.databaseUrl,
        dir: 'db/migrations',
        direction: 'up',
        migrationsTable: 'pgmigrations',
        log: () => undefined,
      });
    const env = (services: TestServices) =>
      readEnv({
        NODE_ENV: 'test',
        LOG_LEVEL: 'silent',
        APP_ROLE: 'worker',
        DATABASE_URL: services.databaseUrl,
        REDIS_URL: services.redisUrl,
      });
    expect(runtimeQueuePrefix(env(first))).toBe(first.redisPrefix);
    expect(runtimeQueuePrefix(env(second))).toBe(second.redisPrefix);
    expect(first.redisPrefix).not.toBe(second.redisPrefix);
    expect(runtimeQueuePrefix({ NODE_ENV: 'production', DATABASE_URL: first.databaseUrl })).toBe(
      'delivery',
    );
    dbA = createDatabase(first.databaseUrl);
    dbB = createDatabase(second.databaseUrl);
    for (const handle of [dbA, dbB])
      await sql`CREATE TABLE isolation_effects(id uuid PRIMARY KEY)`.execute(handle.db);
    appA = await createApplication(env(first));
    appB = await createApplication(env(second));
    const queueA = appA.get<DurableQueue>(PLATFORM_QUEUE);
    const queueB = appB.get<DurableQueue>(PLATFORM_QUEUE);
    const consumer = 'test-isolation-consumer';
    for (const queue of [queueA, queueB])
      queue.registerHandler(consumer, async (tx, event) => {
        await sql`INSERT INTO isolation_effects(id) VALUES (${event.eventId}::uuid) ON CONFLICT DO NOTHING`.execute(
          tx,
        );
      });
    const eventId = uuidV7();
    await dbA.db.transaction().execute((tx) =>
      appendEvent(
        tx,
        {
          eventId,
          eventType: 'test.isolation',
          schemaVersion: 1,
          aggregateType: 'test',
          aggregateId: uuidV7(),
          aggregateVersion: '1',
          occurredAt: new Date().toISOString(),
          correlationId: 'test',
          causationId: null,
          payload: {},
        },
        [consumer],
      ),
    );
    await queueA.recoverOnce();
    const deadline = Date.now() + 10000;
    let complete = false;
    while (Date.now() < deadline && !complete) {
      complete =
        (await sql`SELECT id FROM isolation_effects WHERE id=${eventId}::uuid`.execute(dbA.db)).rows
          .length === 1;
      if (!complete) await delay(30);
    }
    expect(complete).toBe(true);
    expect((await sql`SELECT id FROM isolation_effects`.execute(dbB.db)).rows).toHaveLength(0);
  } finally {
    await appA?.close();
    await appB?.close();
    await dbA?.close();
    await dbB?.close();
    await second?.stop();
    await first.stop();
  }
}, 120000);
