import { createApplication } from '../../../src/bootstrap.js';
import { readEnv } from '../../../src/config/env.schema.js';
import { surfacesFor } from '../../../src/app-roles/roles.js';

const roles = ['all', 'customer', 'rider', 'store', 'admin', 'worker'] as const;
const surfaces = ['customer', 'rider', 'store', 'admin'] as const;

describe('runtime role isolation', () => {
  it.each(roles)('boots %s with only its audience documentation', async (role) => {
    const env = readEnv({
      APP_ROLE: role,
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      METRICS_BEARER_TOKEN: 'test-metrics-token',
    });
    const app = await createApplication(env, [{ name: 'test', async check() {} }]);
    try {
      const server = app.getHttpAdapter().getInstance();
      expect((await server.inject({ method: 'GET', url: '/healthz' })).statusCode).toBe(200);
      expect((await server.inject({ method: 'GET', url: '/readyz' })).statusCode).toBe(200);
      expect((await server.inject({ method: 'GET', url: '/metrics' })).statusCode).toBe(404);
      expect(
        (
          await server.inject({
            method: 'GET',
            url: '/metrics',
            headers: { authorization: 'Bearer test-metrics-token' },
          })
        ).statusCode,
      ).toBe(200);
      for (const surface of surfaces) {
        const response = await server.inject({ method: 'GET', url: `/v1/${surface}/docs-json` });
        expect(response.statusCode).toBe(surfacesFor(role).includes(surface) ? 200 : 404);
        if (response.statusCode === 200) expect(response.json().openapi).toBe('3.1.0');
        expect(
          (await server.inject({ method: 'POST', url: `/v1/${surface}/demo` })).statusCode,
        ).toBe(404);
      }
      const response = await server.inject({
        method: 'GET',
        url: '/missing',
        headers: { 'x-request-id': 'known-request' },
      });
      expect(response.headers['x-request-id']).toBe('known-request');
      expect(response.headers['content-type']).toContain('application/problem+json');
      expect(response.json()).toMatchObject({
        status: 404,
        traceId: 'known-request',
        code: 'NOT_FOUND',
      });
    } finally {
      await app.close();
    }
  });
  it('fails readiness when a dependency rejects or no probe is provided', async () => {
    const env = readEnv({ NODE_ENV: 'test', LOG_LEVEL: 'silent' });
    for (const probes of [
      [],
      [
        {
          name: 'postgres',
          async check(): Promise<void> {
            throw new Error('unavailable');
          },
        },
      ],
    ]) {
      const app = await createApplication(env, probes);
      try {
        expect(
          (await app.getHttpAdapter().getInstance().inject({ method: 'GET', url: '/readyz' }))
            .statusCode,
        ).toBe(503);
      } finally {
        await app.close();
      }
    }
  });
  it('records bounded HTTP metrics without leaking request values', async () => {
    const env = readEnv({
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      METRICS_BEARER_TOKEN: 'test-metrics-token',
    });
    const app = await createApplication(env, [{ name: 'test', async check() {} }]);
    try {
      const server = app.getHttpAdapter().getInstance();
      await server.inject({
        method: 'GET',
        url: '/v1/customer/private-user-123?token=private-secret',
      });
      const metrics = await server.inject({
        method: 'GET',
        url: '/metrics',
        headers: { authorization: 'Bearer test-metrics-token' },
      });
      expect(metrics.body).toContain(
        'delivery_http_request_duration_seconds_count{method="GET",audience="customer",status_class="4xx"} 1',
      );
      expect(metrics.body).toContain('delivery_http_request_duration_seconds_bucket');
      expect(metrics.body).not.toMatch(/private-user-123|private-secret|test-metrics-token/);
    } finally {
      await app.close();
    }
  });
});
