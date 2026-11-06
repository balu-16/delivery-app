import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from 'pg';
import { Redis } from 'ioredis';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';

const POSTGIS_IMAGE =
  'postgis/postgis:16-3.6-alpine@sha256:d5955943c6e633219d80bd1d7fd986a097fdd44f3979c53d4839d62647bba478';
const REDIS_IMAGE =
  'redis:7.4.12-alpine3.21@sha256:338fbfc036dc5517ac0b04d6de21521085935336e565f223406180e9d84166e2';

export interface TestServices {
  databaseUrl: string;
  redisUrl: string;
  /** Use for all Redis keys and queue names; never FLUSHDB on shared services. */
  redisPrefix: string;
  stop(): Promise<void>;
}

async function connectPostgres(url: string): Promise<Client> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 60; attempt++) {
    const client = new Client({ connectionString: url, connectionTimeoutMillis: 1000 });
    try {
      await client.connect();
      return client;
    } catch (error) {
      lastError = error;
      await client.end().catch(() => undefined);
      await delay(500);
    }
  }
  throw new Error('Postgres did not become ready', { cause: lastError });
}

/**
 * Creates an isolated database and Redis namespace per caller. Set both
 * TEST_DATABASE_URL and TEST_REDIS_URL to use already-running real services.
 * The database user must have CREATEDB; never point these at production.
 */
export async function startTestServices(): Promise<TestServices> {
  const configuredDatabase = process.env.TEST_DATABASE_URL;
  const configuredRedis = process.env.TEST_REDIS_URL;
  if (Boolean(configuredDatabase) !== Boolean(configuredRedis)) {
    throw new Error('Set both TEST_DATABASE_URL and TEST_REDIS_URL, or neither');
  }
  const containers: StartedTestContainer[] = [];
  let admin: Client | undefined;
  let databaseCreated = false;
  const id = randomUUID().replaceAll('-', '');
  const databaseName = `delivery_test_${id}`;
  try {
    let databaseUrl = configuredDatabase;
    let redisUrl = configuredRedis;
    if (!databaseUrl || !redisUrl) {
      const postgres = await new GenericContainer(POSTGIS_IMAGE)
        .withEnvironment({
          POSTGRES_USER: 'delivery',
          POSTGRES_PASSWORD: 'delivery',
          POSTGRES_DB: 'postgres',
        })
        .withExposedPorts(5432)
        .withWaitStrategy(Wait.forListeningPorts())
        .start();
      containers.push(postgres);
      databaseUrl = `postgresql://delivery:delivery@${postgres.getHost()}:${postgres.getMappedPort(5432)}/postgres`;
      const redis = await new GenericContainer(REDIS_IMAGE)
        .withExposedPorts(6379)
        .withWaitStrategy(Wait.forListeningPorts())
        .start();
      containers.push(redis);
      redisUrl = `redis://${redis.getHost()}:${redis.getMappedPort(6379)}`;
    }
    admin = await connectPostgres(databaseUrl);
    // The name contains only a fixed prefix and hex UUID generated above.
    await admin.query(`CREATE DATABASE "${databaseName}"`);
    databaseCreated = true;
    const isolatedUrl = new URL(databaseUrl);
    isolatedUrl.pathname = `/${databaseName}`;
    const redis = new Redis(redisUrl, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      connectTimeout: 3000,
    });
    try {
      await redis.connect();
      if ((await redis.ping()) !== 'PONG') throw new Error('Redis ping failed');
    } finally {
      redis.disconnect();
    }
    const adminClient = admin;
    let stopped = false;
    return {
      databaseUrl: isolatedUrl.toString(),
      redisUrl,
      redisPrefix: `test:${id}`,
      async stop() {
        if (stopped) return;
        stopped = true;
        try {
          // pg-pool can finish end() just before the server observes socket closure.
          // Wait for normal disconnects; do not hide leaked handles with FORCE.
          const deadline = Date.now() + 5000;
          for (;;) {
            const result = await adminClient.query<{ count: string }>(
              'SELECT count(*)::text AS count FROM pg_stat_activity WHERE datname=$1',
              [databaseName],
            );
            if (result.rows[0]?.count === '0') break;
            if (Date.now() >= deadline)
              throw new Error('Test database still has active connections after cleanup');
            await delay(25);
          }
          await adminClient.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
        } finally {
          await adminClient.end();
          await Promise.all(containers.map((container) => container.stop()));
        }
      },
    };
  } catch (error) {
    if (admin) {
      if (databaseCreated)
        await admin
          .query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`)
          .catch(() => undefined);
      await admin.end().catch(() => undefined);
    }
    await Promise.all(containers.map((container) => container.stop().catch(() => undefined)));
    throw error;
  }
}
