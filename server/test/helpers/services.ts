import { randomUUID } from 'node:crypto';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from 'pg';
import { Redis } from 'ioredis';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { Signer } from '@aws-sdk/rds-signer';
import { createIamRedis, elasticacheIamToken } from '../../src/platform/redis/redis.js';
import { postgresConnectionConfig } from '../../src/platform/database/database.js';

const POSTGIS_IMAGE =
  'postgis/postgis:16-3.6-alpine@sha256:d5955943c6e633219d80bd1d7fd986a097fdd44f3979c53d4839d62647bba478';
const REDIS_IMAGE =
  'redis:7.4.12-alpine3.21@sha256:338fbfc036dc5517ac0b04d6de21521085935336e565f223406180e9d84166e2';

export interface TestServices {
  databaseUrl: string;
  /** Credential-free URL for test processes that can refresh IAM authentication. */
  databaseIamUrl?: string;
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
export async function startTestServices(
  options: { skipAwsCache?: boolean } = {},
): Promise<TestServices> {
  if (process.env.AWS_P13_INTEGRATION === 'yes')
    return startAwsTestServices(options.skipAwsCache ?? false);
  if (options.skipAwsCache) throw new Error('Skipping cache setup is supported only for AWS tests');
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

/** Opt-in AWS integration fixture. Never use the application database as the test database. */
async function startAwsTestServices(skipCache: boolean): Promise<TestServices> {
  const region = process.env.AWS_REGION;
  const ownerUrl = process.env.MIGRATION_DATABASE_URL;
  const appUrl = process.env.DATABASE_URL;
  const cacheUrl = process.env.CACHE_URL;
  const cacheName = process.env.CACHE_IAM_NAME;
  const cacheUser = process.env.CACHE_IAM_USER;
  if (!region || !ownerUrl || !appUrl || !cacheUrl || !cacheName || !cacheUser)
    throw new Error('AWS integration test settings are incomplete');
  if (
    process.env.NODE_ENV !== 'development' ||
    process.env.DATABASE_AUTH !== 'iam' ||
    process.env.CACHE_AUTH !== 'elasticache-iam'
  )
    throw new Error('AWS integration tests require IAM database and cache authentication');
  if (process.env.TEST_DATABASE_URL || process.env.TEST_REDIS_URL)
    throw new Error('Do not combine AWS integration tests with external test service URLs');
  const owner = new URL(ownerUrl);
  const app = new URL(appUrl);
  if (
    owner.hostname !== app.hostname ||
    owner.port !== app.port ||
    owner.pathname !== '/deliveryapp'
  )
    throw new Error('AWS integration test owner and development database must match');
  const cache = new URL(cacheUrl);
  if (cache.protocol !== 'rediss:' || cache.username || cache.password)
    throw new Error('AWS integration tests require a credential-free TLS cache URL');
  const name = `delivery_p13_${randomUUID().replaceAll('-', '')}`;
  const redisPrefix = `test:${name.slice('delivery_p13_'.length)}`;
  const manifest = `artifacts/${name}-cleanup.json`;
  const admin = new Client({
    ...postgresConnectionConfig(ownerUrl, region),
    connectionTimeoutMillis: 30000,
  });
  // An idle Aurora connection can be reset while a long test runs. Attach an
  // error listener and use a fresh IAM connection for cleanup.
  admin.on('error', () => undefined);
  const dropTestDatabase = async () => {
    const cleanup = new Client({
      ...postgresConnectionConfig(ownerUrl, region),
      connectionTimeoutMillis: 30000,
    });
    cleanup.on('error', () => undefined);
    try {
      await cleanup.connect();
      await cleanup.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    } finally {
      await cleanup.end().catch(() => undefined);
    }
  };
  let created = false;
  let createAttempted = false;
  try {
    await admin.connect();
    const identity = await admin.query<{ db: string; can_create: boolean }>(
      'SELECT current_database() AS db, (SELECT rolcreatedb FROM pg_roles WHERE rolname=current_user) AS can_create',
    );
    if (identity.rows[0]?.db !== 'deliveryapp' || !identity.rows[0]?.can_create)
      throw new Error('AWS integration tests require the development database owner');
    await mkdir('artifacts', { recursive: true });
    await writeFile(
      manifest,
      JSON.stringify({ database: name, cachePrefix: skipCache ? null : redisPrefix, region }),
      {
        mode: 0o600,
      },
    );
    createAttempted = true;
    await admin.query(`CREATE DATABASE "${name}"`);
    created = true;
    owner.pathname = `/${name}`;
    const databaseIamUrl = owner.toString();
    const signer = new Signer({
      hostname: owner.hostname,
      port: Number(owner.port || 5432),
      username: decodeURIComponent(owner.username),
      region,
    });
    owner.password = await signer.getAuthToken();
    owner.searchParams.set('sslmode', 'verify-full');
    if (!skipCache) {
      cache.username = cacheUser;
      cache.password = await elasticacheIamToken({
        url: cacheUrl,
        cacheName,
        username: cacheUser,
        region,
      });
      let cacheError: unknown;
      for (let attempt = 0; attempt < 3; attempt++) {
        const redis = new Redis(cache.toString(), {
          lazyConnect: true,
          connectTimeout: 15000,
          maxRetriesPerRequest: 1,
        });
        redis.on('error', () => undefined);
        try {
          await redis.connect();
          if ((await redis.ping()) !== 'PONG') throw new Error('AWS test cache ping failed');
          cacheError = undefined;
          break;
        } catch (error) {
          cacheError = error;
          if (attempt < 2) await delay(1000);
        } finally {
          redis.disconnect();
        }
      }
      if (cacheError) throw new Error('AWS test cache setup failed', { cause: cacheError });
    }
    await admin.end();
    let stopped = false;
    return {
      databaseUrl: owner.toString(),
      databaseIamUrl,
      redisUrl: cache.toString(),
      redisPrefix,
      async stop() {
        if (stopped) return;
        let cleanupError: unknown;
        for (let attempt = 0; !skipCache && attempt < 3; attempt++) {
          let clean: Redis | undefined;
          try {
            clean = await createIamRedis({
              url: cacheUrl!,
              cacheName: cacheName!,
              username: cacheUser!,
              region: region!,
            });
            clean.on('error', () => undefined);
            await clean.connect();
            for (let pass = 0; pass < 10; pass++) {
              let cursor = '0';
              const found: string[] = [];
              do {
                const [next, keys] = await clean.scan(
                  cursor,
                  'MATCH',
                  `${redisPrefix}:*`,
                  'COUNT',
                  200,
                );
                cursor = next;
                found.push(...keys);
              } while (cursor !== '0');
              if (found.length === 0) break;
              for (const key of found) await clean.del(key);
              if (pass === 9) throw new Error('AWS test cache keys are still being created');
            }
            cleanupError = undefined;
            break;
          } catch (error) {
            cleanupError = error;
            if (attempt < 2) await delay(1000);
          } finally {
            clean?.disconnect();
          }
        }
        await dropTestDatabase();
        if (cleanupError) throw new Error('AWS test cache cleanup failed', { cause: cleanupError });
        await unlink(manifest);
        stopped = true;
      },
    };
  } catch (error) {
    await admin.end().catch(() => undefined);
    if (created) {
      try {
        await dropTestDatabase();
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], 'AWS test setup and cleanup both failed', {
          cause: cleanupError,
        });
      }
    }
    if (!createAttempted || created)
      await unlink(manifest).catch((unlinkError: NodeJS.ErrnoException) => {
        if (unlinkError.code !== 'ENOENT') throw unlinkError;
      });
    if (createAttempted && !created)
      throw new Error(`AWS test database creation outcome is unknown; inspect ${manifest}`, {
        cause: error,
      });
    throw error;
  }
}
