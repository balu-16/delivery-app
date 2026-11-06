import { setTimeout as delay } from 'node:timers/promises';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { ConcernQueues } from '../../../src/platform/queue/concern-queues.js';
import { startTestServices, type TestServices } from '../../helpers/services.js';

let services: TestServices;
beforeAll(async () => {
  services = await startTestServices();
}, 120000);
afterAll(async () => {
  await services?.stop();
}, 120000);
async function eventually(check: () => Promise<boolean> | boolean): Promise<void> {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(40);
  }
  throw new Error('Timed out waiting for queue');
}

it('runs recurring schedulers idempotently, retries failures and permits bounded dead-letter replay', async () => {
  const connection = new Redis(services.redisUrl, { maxRetriesPerRequest: null });
  const inspection = new Queue('maintenance', { connection, prefix: services.redisPrefix });
  const queues = new ConcernQueues({
    redisUrl: services.redisUrl,
    prefix: services.redisPrefix,
    attempts: 2,
    retryDelayMs: 100,
    concurrency: 1,
  });
  let ticks = 0,
    attempts = 0,
    replayed = 0;
  let canReplay = false;
  try {
    queues.register('maintenance', 'tick', async () => {
      ticks++;
    });
    queues.register('maintenance', 'retry', async () => {
      attempts++;
      if (attempts === 1) throw new Error('retry');
    });
    queues.register('maintenance', 'dead', async () => {
      if (!canReplay) throw new Error('fail');
      replayed++;
    });
    await queues.upsertScheduler('maintenance', 'frequent', 'tick', {}, { everyMs: 200 });
    await queues.upsertScheduler('maintenance', 'frequent', 'tick', {}, { everyMs: 200 });
    await queues.upsertScheduler('maintenance', 'daily', 'tick', {}, { pattern: '0 3 * * *' });
    const schedulers = await inspection.getJobSchedulers();
    expect(schedulers.filter((entry) => entry.key === 'frequent')).toHaveLength(1);
    expect(schedulers.find((entry) => entry.key === 'daily')?.tz).toBe('Asia/Kolkata');
    await queues.enqueue('maintenance', 'retry', {}, 'retry-operation');
    await queues.enqueue('maintenance', 'dead', {}, 'dead-operation');
    await eventually(
      async () =>
        ticks >= 2 &&
        attempts === 2 &&
        (await queues.listFailed('maintenance')).some((job) => job.name === 'dead'),
    );
    const failed = (await queues.listFailed('maintenance')).find((job) => job.name === 'dead')!;
    expect(failed.attempts).toBe(2);
    canReplay = true;
    await queues.replay('maintenance', failed.id);
    await eventually(() => replayed === 1);
    expect((await queues.listFailed('maintenance')).some((job) => job.id === failed.id)).toBe(
      false,
    );
  } finally {
    await inspection.removeJobScheduler('frequent');
    await inspection.removeJobScheduler('daily');
    await queues.close();
    await inspection.obliterate({ force: true });
    await inspection.close();
    await connection.quit();
  }
}, 30000);
