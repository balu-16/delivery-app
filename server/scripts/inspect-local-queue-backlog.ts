import { Redis } from 'ioredis';
import { CONCERNS } from '../src/platform/queue/concern-queues.js';

/** A deliberately read-only inventory. No Queue/Worker is instantiated. */
async function main(): Promise<void> {
  const value = process.env.REDIS_URL;
  if (!value) throw new Error('REDIS_URL is required');
  const url = new URL(value);
  if (
    !['redis:', 'rediss:'].includes(url.protocol) ||
    !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  )
    throw new Error('Backlog inspection is restricted to the configured local Redis instance');
  const redis = new Redis(value, {
    lazyConnect: true,
    connectTimeout: 3000,
    commandTimeout: 3000,
    maxRetriesPerRequest: 0,
    enableOfflineQueue: false,
    retryStrategy: () => null,
  });
  redis.on('error', () => undefined);
  try {
    await redis.connect();
    for (const queue of ['platform-events', ...CONCERNS]) {
      const prefix = `delivery:${queue}:`;
      const [waiting, paused, active, delayed, failed, prioritized, waitingChildren, schedulers] =
        await Promise.all([
          redis.llen(`${prefix}wait`),
          redis.llen(`${prefix}paused`),
          redis.llen(`${prefix}active`),
          redis.zcard(`${prefix}delayed`),
          redis.zcard(`${prefix}failed`),
          redis.zcard(`${prefix}prioritized`),
          redis.zcard(`${prefix}waiting-children`),
          redis.zcard(`${prefix}repeat`),
        ]);
      process.stdout.write(
        `${JSON.stringify({ queue, waiting, paused, active, delayed, failed, prioritized, waitingChildren, schedulers })}\n`,
      );
    }
    process.stdout.write(
      'Counts are a point-in-time inventory, not proof that a live queue is drained. Stop producers and workers and repeat before cutover.\n',
    );
  } finally {
    redis.disconnect();
  }
}

void main().catch(() => {
  process.stderr.write(
    'Local queue inspection failed; start the existing Redis instance without deleting its data, then retry.\n',
  );
  process.exitCode = 1;
});
