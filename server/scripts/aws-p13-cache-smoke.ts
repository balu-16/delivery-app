import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import {
  createIamRedis,
  duplicateRedis,
  elasticacheIamToken,
} from '../src/platform/redis/redis.js';

async function main() {
  if (process.env.NODE_ENV !== 'development' || process.env.AWS_P13_CACHE_SMOKE !== 'yes')
    throw new Error('AWS_P13_CACHE_SMOKE=yes in development is required');
  const config = {
    url: process.env.CACHE_URL ?? '',
    cacheName: process.env.CACHE_IAM_NAME ?? '',
    username: process.env.CACHE_IAM_USER ?? '',
    region: process.env.AWS_REGION ?? '',
  };
  if (
    !config.url.startsWith('rediss://') ||
    !config.cacheName ||
    !config.username ||
    !config.region
  )
    throw new Error('An IAM TLS cache configuration is required');
  const key = `p13:cache:${randomUUID()}`;
  const value = randomUUID();
  const redis = await createIamRedis(config);
  const duplicate = await duplicateRedis(redis);
  let failure: unknown;
  try {
    await Promise.all([redis.connect(), duplicate.connect()]);
    assert.equal(await redis.set(key, value, 'EX', 300, 'NX'), 'OK');
    assert.equal(await duplicate.get(key), value);
    assert.equal(await duplicate.set(key, 'other', 'EX', 300, 'NX'), null);
    redis.options.password = await elasticacheIamToken(config);
    const reconnected = once(redis, 'ready', { signal: AbortSignal.timeout(30000) });
    redis.disconnect(true);
    await reconnected;
    assert.equal(await redis.get(key), value);
    assert.equal(await redis.del(key), 1);
    assert.equal(await duplicate.get(key), null);
    console.log(
      'Valkey reconnect with a newly signed IAM token, cross-client visibility and NX exclusion passed',
    );
  } catch (error) {
    failure = error;
  } finally {
    try {
      if (duplicate.status !== 'ready') await duplicate.connect();
      await duplicate.del(key);
    } catch {
      console.error(
        'Could not clean the temporary cache key; it expires automatically within five minutes',
      );
      process.exitCode = 1;
    }
    await Promise.allSettled([redis.quit(), duplicate.quit()]);
  }
  if (failure) throw failure;
}
void main().catch((error: unknown) => {
  console.error(
    'AWS cache P13 test failed:',
    error instanceof Error ? error.message : 'unknown error',
  );
  process.exitCode = 1;
});
