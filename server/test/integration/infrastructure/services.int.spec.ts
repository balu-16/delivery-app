import { Client } from 'pg';
import { createHash } from 'node:crypto';
import { checkRateLimit } from '../../../src/common/http/rate-limit.js';
import { Redis } from 'ioredis';
import { startTestServices, type TestServices } from '../../helpers/services.js';

describe('real test services', () => {
  let services: TestServices;
  let database: Client;
  let redis: Redis;

  beforeAll(async () => {
    services = await startTestServices();
    database = new Client({ connectionString: services.databaseUrl });
    await database.connect();
    redis = new Redis(services.redisUrl);
  }, 120000);

  afterAll(async () => {
    if (redis) {
      await redis.del(`${services.redisPrefix}:probe`);
      await redis.quit();
    }
    if (database) await database.end();
    if (services) await services.stop();
  }, 30000);

  it('runs PostGIS spatial predicates in the isolated database', async () => {
    await database.query('CREATE EXTENSION IF NOT EXISTS postgis');
    const result = await database.query<{ covered: boolean }>(
      "SELECT ST_Covers(ST_GeomFromText('POLYGON((0 0,1 0,1 1,0 1,0 0))'), ST_Point(0, 0)) AS covered",
    );
    expect(result.rows[0]?.covered).toBe(true);
  });

  it('enforces one shared rate limit across concurrent instances', async () => {
    const actor = `${services.redisPrefix}:actor`;
    const digest = createHash('sha256').update(actor).digest('hex');
    try {
      const results = await Promise.all(
        Array.from({ length: 30 }, () => checkRateLimit(redis, actor, 'test', 10)),
      );
      expect(results.filter((result) => result.allowed)).toHaveLength(10);
      expect(
        results.filter((result) => !result.allowed).every((result) => result.retryAfter > 0),
      ).toBe(true);
    } finally {
      await redis.del(`delivery:rate:test:${digest}`);
    }
  });

  it('reads and deletes a namespaced key on Redis', async () => {
    const key = `${services.redisPrefix}:probe`;
    await redis.set(key, 'ok', 'EX', 30);
    expect(await redis.get(key)).toBe('ok');
    expect(await redis.del(key)).toBe(1);
  });
});
