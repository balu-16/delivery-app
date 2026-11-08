import { jest } from '@jest/globals';
import { createIamRedisCluster } from '../../../src/platform/redis/iam-cluster.js';

const config = {
  url: 'rediss://cache.example:6379',
  cacheName: 'cache',
  username: 'user',
  region: 'ap-southeast-2',
};

test('cluster connections require TLS and fetch fresh IAM credentials per connection', async () => {
  const issue = jest
    .fn<() => Promise<string>>()
    .mockResolvedValueOnce('token-1')
    .mockResolvedValueOnce('token-2');
  const cluster = createIamRedisCluster(config, issue);
  const options = cluster._options.defaults;
  expect(options?.socket?.tls).toBe(true);
  const provider = options?.credentialsProvider;
  if (!provider || provider.type !== 'async-credentials-provider')
    throw new Error('missing provider');
  await expect(provider.credentials()).resolves.toEqual({ username: 'user', password: 'token-1' });
  await expect(provider.credentials()).resolves.toEqual({ username: 'user', password: 'token-2' });
  expect(issue).toHaveBeenCalledTimes(2);
});

test.each([
  'redis://cache.example',
  'rediss://user:password@cache.example',
  'rediss://cache.example/1',
  'rediss://cache.example?secret=value',
])('rejects an unsafe or unsupported endpoint', (url) =>
  expect(() => createIamRedisCluster({ ...config, url })).toThrow(
    'INVALID_IAM_CACHE_CONFIGURATION',
  ),
);
