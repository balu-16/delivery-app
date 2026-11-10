import { jest } from '@jest/globals';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Redis } from 'ioredis';
import { createIamRedis } from '../../../src/platform/redis/redis.js';
import { RedisRiderGeo } from '../../../src/modules/tracking/infrastructure/redis-geo.js';
import { startTestServices, type TestServices } from '../../helpers/services.js';

let services: TestServices | undefined;
let redis: Redis;
const aws = process.env.AWS_P13_INTEGRATION === 'yes';
const timeout = aws ? 120000 : 120000;
if (aws) jest.setTimeout(timeout);
const namespace = `p13geo-${randomUUID().replaceAll('-', '')}`;
const geoKey = `${namespace}:{rider-geo}:geo`;
const rider = randomUUID();
const hashKey = `${namespace}:{rider-geo}:rider:${rider}`;
const tombstoneKey = `${namespace}:{rider-geo}:erased:${rider}`;
beforeAll(async () => {
  if (aws) {
    const { CACHE_URL, CACHE_IAM_NAME, CACHE_IAM_USER, AWS_REGION } = process.env;
    if (!CACHE_URL || !CACHE_IAM_NAME || !CACHE_IAM_USER || !AWS_REGION)
      throw new Error('IAM cache settings are required');
    redis = await createIamRedis({
      url: CACHE_URL,
      cacheName: CACHE_IAM_NAME,
      username: CACHE_IAM_USER,
      region: AWS_REGION,
    });
  } else {
    services = await startTestServices();
    redis = new Redis(services.redisUrl, { lazyConnect: true });
  }
  redis.on('error', () => undefined);
  await redis.connect();
}, timeout);
afterAll(async () => {
  try {
    if (redis && redis.status === 'ready') await redis.del(geoKey, hashKey, tombstoneKey);
  } finally {
    redis?.disconnect();
    await services?.stop();
  }
}, timeout);

it('excludes and prunes a stale GEO member after its freshness hash expires', async () => {
  const geo = new RedisRiderGeo(redis, namespace);
  const point = { lat: 13, lng: 77.6 };
  expect(await geo.updateMember(rider, { ...point, ts: new Date().toISOString() }, 1)).toBe(true);
  expect(await geo.candidatesNear(point, 1000, 10)).toContain(rider);
  const deadline = Date.now() + 10000;
  while ((await redis.exists(hashKey)) && Date.now() < deadline) await delay(100);
  expect(await redis.exists(hashKey)).toBe(0);
  expect(await redis.zscore(geoKey, rider)).not.toBeNull();
  expect(await geo.candidatesNear(point, 1000, 10)).not.toContain(rider);
  expect(await geo.pruneExpired()).toBe(1);
  expect(await redis.zscore(geoKey, rider)).toBeNull();
});
