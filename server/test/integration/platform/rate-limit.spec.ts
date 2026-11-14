import { Redis } from 'ioredis';
import { checkRateLimit, routeLimit } from '../../../src/common/http/rate-limit.js';
import { readEnv } from '../../../src/config/env.schema.js';
import { startTestServices, type TestServices } from '../../helpers/services.js';
import { RedisRateLimiter } from '../../../src/platform/redis/rate-limiter.js';
import { createApplication } from '../../../src/bootstrap.js';
import { randomInt } from 'node:crypto';

let services: TestServices;
beforeAll(async () => {
  services = await startTestServices();
}, 120000);
afterAll(async () => {
  await services?.stop();
}, 120000);

it('shares counters across Redis clients, separates route classes, and sets an expiry', async () => {
  const first = new Redis(services.redisUrl);
  const second = new Redis(services.redisUrl);
  const actor = services.redisPrefix;
  try {
    expect((await checkRateLimit(first, actor, 'default', 2)).allowed).toBe(true);
    expect((await checkRateLimit(second, actor, 'default', 2)).allowed).toBe(true);
    const denied = await checkRateLimit(first, actor, 'default', 2);
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfter).toBeGreaterThan(0);
    expect(denied.retryAfter).toBeLessThanOrEqual(60);
    expect((await checkRateLimit(second, actor, 'location', 2)).allowed).toBe(true);
    const env = readEnv({});
    expect(routeLimit('/v1/rider/location', env)?.name).toBe('location');
    expect(routeLimit('/v1/customer/webhooks/payments/razorpay', env)).toEqual({
      name: 'webhook',
      limit: 1200,
    });
    expect(routeLimit('/v1/webhooks/payments/razorpay', env)?.name).toBe('default');
  } finally {
    await first.quit();
    await second.quit();
  }
});

it('limits verified actors independently by audience and returns an explicit outage policy', async () => {
  const redis = new Redis(services.redisUrl);
  const env = readEnv({ RATE_LIMIT_DEFAULT_PER_MIN: '1', RATE_LIMIT_SEARCH_PER_MIN: '1' });
  let errors = 0;
  const limiter = new RedisRateLimiter(redis, env, () => {
    errors++;
  });
  const actor = `CUSTOMER:${services.redisPrefix}`;
  try {
    expect((await limiter.checkAuthenticated(actor, 'customer', '/v1/customer/me')).kind).toBe(
      'allowed',
    );
    expect((await limiter.checkAuthenticated(actor, 'customer', '/v1/customer/me')).kind).toBe(
      'limited',
    );
    expect((await limiter.checkAuthenticated(actor, 'rider', '/v1/rider/me')).kind).toBe('allowed');
    expect(
      (await limiter.checkAuthenticated(actor, 'customer', '/v1/customer/search?q=milk')).kind,
    ).toBe('allowed');
    expect(
      (await limiter.checkAuthenticated(actor, 'customer', '/v1/customer/search/suggest?q=milk'))
        .kind,
    ).toBe('limited');
    const original = redis.eval;
    redis.eval = (() => Promise.reject(new Error('Redis unavailable'))) as typeof redis.eval;
    try {
      expect(await limiter.checkAuthenticated(actor, 'customer', '/v1/customer/me')).toEqual({
        kind: 'unavailable',
        failClosed: false,
      });
      expect(await limiter.checkAuthenticated(actor, 'rider', '/v1/rider/location')).toEqual({
        kind: 'unavailable',
        failClosed: true,
      });
      expect(errors).toBe(2);
    } finally {
      redis.eval = original;
    }
  } finally {
    await redis.quit();
  }
});

it('uses forwarded client addresses only from an explicitly trusted proxy', async () => {
  const octet = randomInt(1, 255);
  const proxy = `10.88.${octet}.1`;
  const untrusted = `192.0.2.${octet}`;
  const clientA = `198.51.${octet}.10`,
    clientB = `198.51.${octet}.11`;
  const app = await createApplication(
    readEnv({
      NODE_ENV: 'test',
      APP_ROLE: 'customer',
      LOG_LEVEL: 'silent',
      DATABASE_URL: services.databaseUrl,
      REDIS_URL: services.redisUrl,
      TRUSTED_PROXY_CIDRS: `${proxy}/32`,
      RATE_LIMIT_AUTH_PER_MIN: '1',
    }),
  );
  try {
    const send = (remoteAddress: string, forwarded: string) =>
      app
        .getHttpAdapter()
        .getInstance()
        .inject({
          method: 'GET',
          url: '/v1/customer/auth/not-a-route',
          remoteAddress,
          headers: { 'x-forwarded-for': forwarded },
        });
    expect((await send(proxy, clientA)).statusCode).toBe(404);
    expect((await send(proxy, clientB)).statusCode).toBe(404);
    expect((await send(proxy, clientA)).statusCode).toBe(429);
    expect((await send(untrusted, clientA)).statusCode).toBe(404);
    expect((await send(untrusted, clientB)).statusCode).toBe(429);
  } finally {
    await app.close();
  }
});
