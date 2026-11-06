import { Redis } from 'ioredis';

/** Own connection; call quit on normal shutdown. BullMQ connections are separate. */
export function createRedis(url: string): Redis {
  if (!url) throw new Error('REDIS_URL is required');
  return new Redis(url, {
    maxRetriesPerRequest: 1,
    connectTimeout: 5000,
    commandTimeout: 2000,
    lazyConnect: true,
  });
}
