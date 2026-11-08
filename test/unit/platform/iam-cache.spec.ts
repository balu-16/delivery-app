import { jest } from '@jest/globals';
import { createIamRedis, duplicateRedis } from '../../../src/platform/redis/redis.js';

test('IAM cache refreshes reconnect credentials and retries signing failures', async () => {
  jest.useFakeTimers();
  const issue = jest
    .fn<() => Promise<string>>()
    .mockResolvedValueOnce('first-token')
    .mockRejectedValueOnce(new Error('credentials unavailable'))
    .mockResolvedValueOnce('second-token');
  const redis = await createIamRedis(
    {
      url: 'rediss://cache.example:6379',
      cacheName: 'cache',
      username: 'cache-user',
      region: 'ap-southeast-2',
    },
    issue,
  );
  expect(redis.options.password).toBe('first-token');
  expect(redis.options.tls?.rejectUnauthorized).toBe(true);
  await jest.advanceTimersByTimeAsync(5 * 60_000);
  expect(redis.options.password).toBe('first-token');
  await jest.advanceTimersByTimeAsync(60_000);
  expect(redis.options.password).toBe('second-token');
  redis.disconnect();
  jest.useRealTimers();
});

test('IAM subscriber connections obtain and refresh their own credentials', async () => {
  jest.useFakeTimers();
  try {
    const issue = jest
      .fn<() => Promise<string>>()
      .mockResolvedValueOnce('publisher-token')
      .mockResolvedValueOnce('subscriber-token')
      .mockResolvedValueOnce('publisher-next')
      .mockResolvedValueOnce('subscriber-next');
    const publisher = await createIamRedis(
      {
        url: 'rediss://cache.example:6379',
        cacheName: 'cache',
        username: 'cache-user',
        region: 'ap-southeast-2',
      },
      issue,
    );
    const subscriber = await duplicateRedis(publisher);
    expect(publisher.options.password).toBe('publisher-token');
    expect(subscriber.options.password).toBe('subscriber-token');
    await jest.advanceTimersByTimeAsync(5 * 60_000);
    expect(publisher.options.password).toBe('publisher-next');
    expect(subscriber.options.password).toBe('subscriber-next');
    publisher.disconnect();
    subscriber.disconnect();
  } finally {
    jest.useRealTimers();
  }
});
