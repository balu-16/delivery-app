import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { LogController } from 'fastify';
import { NestFactory } from '@nestjs/core';
import { PayloadTooLargeException, ValidationPipe } from '@nestjs/common';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { RoleModule } from './app-roles/roles.js';
import type { Env } from './config/env.schema.js';
import { ProblemFilter, createProblem } from './common/http/problem.filter.js';
import { registerOpenApi } from './common/http/openapi.js';
import type { ReadinessProbe } from './platform/health/contracts.js';
import { createLogger, createNestLogger } from './common/logging/logger.js';
import { checkRateLimit, routeLimit } from './common/http/rate-limit.js';
import { PLATFORM_REDIS } from './platform/contracts/runtime.js';
import type { Redis } from 'ioredis';
import { HttpMetrics } from './platform/metrics/http-metrics.js';

/** Construct but do not listen, so role isolation can be tested without sockets. */
export async function createApplication(
  env: Env,
  probes?: ReadinessProbe[],
): Promise<NestFastifyApplication> {
  const logger = createLogger(env.LOG_LEVEL);
  const adapter = new FastifyAdapter({
    loggerInstance: logger,
    bodyLimit: env.HTTP_BODY_LIMIT_BYTES,
    logController: new LogController({ disableRequestLogging: true }),
    genReqId: (request: IncomingMessage) => {
      const supplied = request.headers['x-request-id'];
      return typeof supplied === 'string' && /^[A-Za-z0-9._-]{1,128}$/.test(supplied)
        ? supplied
        : randomUUID();
    },
  });
  const app = await NestFactory.create<NestFastifyApplication>(
    RoleModule.forRole(env, probes),
    adapter,
    { logger: createNestLogger(logger), abortOnError: false },
  );
  const fastify = adapter.getInstance();
  // Nest maps Fastify parser errors into the same global problem filter.
  const metrics = app.get(HttpMetrics);
  fastify.addHook('onResponse', async (request, reply) => {
    metrics.observe(request.method, request.url, reply.statusCode, reply.elapsedTime);
  });
  if (env.NODE_ENV !== 'production' && env.STORAGE_PROVIDER === 'local') {
    fastify.addHook('onRequest', async (request, reply) => {
      if (
        request.headers['content-type']?.split(';')[0]?.trim().toLowerCase() ===
          'application/octet-stream' &&
        (request.method !== 'PUT' ||
          !/^\/dev\/(?:private|catalog)-media\/[^/?]+(?:\?|$)/.test(request.url))
      ) {
        reply
          .header('x-request-id', request.id)
          .status(415)
          .type('application/problem+json')
          .send(createProblem(415, request.id));
      }
    });
    fastify.addContentTypeParser(
      'application/octet-stream',
      {
        parseAs: 'buffer',
        bodyLimit: Math.max(env.PRIVATE_UPLOAD_MAX_BYTES, env.CATALOG_UPLOAD_MAX_BYTES),
      },
      (request, body, done) => {
        const limit = request.url.startsWith('/dev/private-media/')
          ? env.PRIVATE_UPLOAD_MAX_BYTES
          : env.CATALOG_UPLOAD_MAX_BYTES;
        if (body.length > limit) {
          done(new PayloadTooLargeException());
          return;
        }
        done(null, body);
      },
    );
  }
  fastify.addHook('onRequest', async (request, reply) => {
    reply.header('x-request-id', request.id);
    reply.header('x-content-type-options', 'nosniff');
    reply.header('x-frame-options', 'DENY');
    reply.header('referrer-policy', 'no-referrer');
    const docs =
      env.NODE_ENV !== 'production' &&
      /^\/v1\/(customer|rider|store|admin)\/docs(?:[/-]|$)/.test(request.url);
    reply.header(
      'content-security-policy',
      docs
        ? "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'"
        : "default-src 'none'; frame-ancestors 'none'",
    );
    reply.header('cache-control', 'no-store');
  });
  if (!probes) {
    const redis = app.get<Redis>(PLATFORM_REDIS);
    fastify.addHook('onRequest', async (request, reply) => {
      const route = routeLimit(request.url.split('?')[0] ?? '', env);
      if (!route) return;
      try {
        const audience =
          /^\/v1\/(customer|rider|store|admin)(?:\/|$)/.exec(request.url)?.[1] ?? 'other';
        // Shared-NAT clients get a broader IP envelope; auth-adjacent routes
        // retain their stricter anonymous limit before identity is verified.
        const ipLimit =
          route.name === 'auth' ? route.limit : Math.min(route.limit * 10, Number.MAX_SAFE_INTEGER);
        const result = await checkRateLimit(
          redis,
          request.ip,
          `${audience}:${route.name}`,
          ipLimit,
        );
        if (!result.allowed) {
          reply
            .header('retry-after', result.retryAfter)
            .status(429)
            .type('application/problem+json')
            .send({
              type: 'about:blank',
              title: 'Too Many Requests',
              status: 429,
              code: 'RATE_LIMITED',
              detail: 'Too Many Requests',
              traceId: request.id,
            });
        }
      } catch {
        logger.warn({ routeClass: route.name }, 'Distributed rate limiter unavailable');
        // Location ingestion is high-volume and must stop when its distributed
        // limiter is unavailable. Other routes remain available in degraded mode.
        if (route.name === 'location')
          reply.header('retry-after', '5').status(503).type('application/problem+json').send({
            type: 'about:blank',
            title: 'Service Unavailable',
            status: 503,
            code: 'RATE_LIMIT_UNAVAILABLE',
            detail: 'Service Unavailable',
            traceId: request.id,
          });
      }
    });
  }
  app.enableCors({
    origin: env.CORS_ALLOWED_ORIGINS.split(',').map((origin) => origin.trim()),
    credentials: true,
    exposedHeaders: ['ETag', 'X-Request-Id', 'Retry-After'],
  });
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
  );
  app.useGlobalFilters(new ProblemFilter(logger));
  registerOpenApi(app, env);
  await app.init();
  await fastify.ready();
  return app;
}
