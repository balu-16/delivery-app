import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { Redis } from 'ioredis';
import { createApplication } from '../src/bootstrap.js';
import { makeOpenApiDocument } from '../src/common/http/openapi.js';
import { readEnv } from '../src/config/env.schema.js';
import { PLATFORM_REDIS } from '../src/platform/contracts/runtime.js';

async function main() {
  if (
    process.env.NODE_ENV !== 'development' ||
    process.env.AUTH_PROVIDER !== 'cognito' ||
    process.env.AWS_P13_AUTH_SWEEP !== 'yes'
  )
    throw new Error(
      'An AWS development Cognito environment and AWS_P13_AUTH_SWEEP=yes are required',
    );
  const inventory = JSON.parse(await readFile('test/security/operation-cases.json', 'utf8')) as {
    items: Array<{ method: string; path: string; authentication: { status: string } }>;
  };
  const expected = new Set(
    inventory.items
      .filter((row) => row.authentication.status !== 'not-applicable')
      .map((row) => `${row.method.toUpperCase()} ${row.path}`),
  );
  const observed = new Set<string>();
  for (const audience of ['customer', 'rider', 'store', 'admin'] as const) {
    const env = readEnv({
      ...process.env,
      APP_ROLE: audience,
      LOG_LEVEL: 'silent',
      RATE_LIMIT_DEFAULT_PER_MIN: '10000',
      RATE_LIMIT_AUTH_PER_MIN: '10000',
      RATE_LIMIT_SEARCH_PER_MIN: '10000',
      RATE_LIMIT_LOCATION_PER_MIN: '10000',
    });
    const app = await createApplication(env);
    const redis = app.get<Redis>(PLATFORM_REDIS);
    const id = randomUUID().replaceAll('-', '');
    const ip = `2001:db8:${id.slice(0, 4)}:${id.slice(4, 8)}::1`;
    const hash = createHash('sha256').update(ip).digest('hex');
    const keys = ['auth', 'default', 'search', 'location'].map(
      (route) => `delivery:rate:${audience}:${route}:${hash}`,
    );
    try {
      const document = makeOpenApiDocument(app, audience);
      const http = app.getHttpAdapter().getInstance();
      for (const [route, entry] of Object.entries(document.paths)) {
        for (const method of ['get', 'post', 'put', 'patch', 'delete'] as const) {
          if (!entry?.[method] || entry[method]!.security?.length === 0) continue;
          const key = `${method.toUpperCase()} ${route}`;
          if (!expected.has(key)) throw new Error(`Unexpected guarded route: ${key}`);
          const url = route.replace(/\{[^}]+\}/g, '01800000-0000-7000-8000-000000000011');
          const response = await http.inject({
            method: method.toUpperCase(),
            url,
            remoteAddress: ip,
          });
          assert.equal(response.statusCode, 401, `Missing credentials: ${key}`);
          observed.add(key);
        }
      }
      console.log(`${audience}: missing-credential checks passed`);
    } finally {
      try {
        for (const key of keys) await redis.del(key);
      } finally {
        await app.close();
      }
    }
  }
  assert.deepEqual(
    [...observed].sort(),
    [...expected].sort(),
    'Guarded operation inventory differs',
  );
  console.log(
    `AWS-backed missing-credential checks passed for ${observed.size} guarded operations`,
  );
}
void main().catch((error: unknown) => {
  console.error(
    'AWS P13 authorization sweep failed:',
    error instanceof Error ? error.message : 'unknown error',
  );
  process.exitCode = 1;
});
