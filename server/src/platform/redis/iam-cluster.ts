import { createCluster } from 'redis';
import { elasticacheIamToken, type IamCacheConfig } from './redis.js';

/** Create sharded pub/sub connections that obtain a fresh IAM token on every connection. */
export function createIamRedisCluster(
  config: IamCacheConfig,
  issueToken: (config: IamCacheConfig) => Promise<string> = elasticacheIamToken,
) {
  const endpoint = new URL(config.url);
  if (
    endpoint.protocol !== 'rediss:' ||
    endpoint.username ||
    endpoint.password ||
    (endpoint.pathname !== '' && endpoint.pathname !== '/') ||
    endpoint.search ||
    endpoint.hash ||
    !config.cacheName ||
    !config.username ||
    !config.region
  )
    throw new Error('INVALID_IAM_CACHE_CONFIGURATION');
  return createCluster({
    rootNodes: [{ url: config.url }],
    defaults: {
      socket: { tls: true, connectTimeout: 10000 },
      credentialsProvider: {
        type: 'async-credentials-provider',
        credentials: async () => ({
          username: config.username,
          password: await issueToken(config),
        }),
      },
    },
  });
}
