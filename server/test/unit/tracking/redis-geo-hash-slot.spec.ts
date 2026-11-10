import type { Redis } from 'ioredis';
import { RedisRiderGeo } from '../../../src/modules/tracking/infrastructure/redis-geo.js';

test('tracking scripts and transactions use keys in one Redis Cluster slot', async () => {
  const keys: string[] = [];
  const pipeline = {
    set: (key: string) => {
      keys.push(key);
      return pipeline;
    },
    del: (key: string) => {
      keys.push(key);
      return pipeline;
    },
    zrem: (key: string) => {
      keys.push(key);
      return pipeline;
    },
    exec: async () => [],
  };
  const redis = {
    eval: async (_script: string, count: number, ...args: string[]) => {
      keys.push(...args.slice(0, count));
      return 1;
    },
    multi: () => pipeline,
  } as unknown as Redis;
  const geo = new RedisRiderGeo(redis);
  await geo.updateMember('rider-1', { lat: 12.97, lng: 77.59, ts: new Date().toISOString() }, 60);
  await geo.removeMember('rider-1');
  const tags = keys.map((key) => /\{([^{}]+)\}/.exec(key)?.[1]);
  expect(tags).toHaveLength(6);
  expect(new Set(tags).size).toBe(1);
  expect(tags[0]).toBeTruthy();
});
