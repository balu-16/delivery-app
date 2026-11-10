import type { INestApplication } from '@nestjs/common';
import { DocumentBuilder, type OpenAPIObject, SwaggerModule } from '@nestjs/swagger';
import { type Surface, surfaceModules, surfacesFor } from '../../app-roles/roles.js';
import type { Env } from '../../config/env.schema.js';
import { DOMAIN_ERROR_STATUS, PROBLEM_CODES } from './problem-codes.js';
import { createProblem } from './problem.filter.js';

/** Build a per-audience OpenAPI 3.1 document. */
export function makeOpenApiDocument(app: INestApplication, surface: Surface): OpenAPIObject {
  const options = new DocumentBuilder()
    .setOpenAPIVersion('3.1.0')
    .setTitle(`Delivery ${surface} API`)
    .setVersion('1.0.0')
    .addBearerAuth()
    .build();
  const document = SwaggerModule.createDocument(app, options, {
    include: [surfaceModules[surface]],
    deepScanRoutes: true,
  });
  // The raw-byte gateway ingress is registered directly with Fastify.
  if (surface === 'customer')
    document.paths['/v1/customer/webhooks/payments/{gateway}'] = {
      post: {
        operationId: 'paymentWebhook',
        summary: 'Persist a signed gateway event',
        security: [],
        description:
          'Authenticates the exact request bytes with the gateway HMAC signature. Invalid signatures are quarantined and cannot fund an order.',
        parameters: [
          {
            name: 'gateway',
            in: 'path',
            required: true,
            schema: { type: 'string', enum: ['fake', 'razorpay'] },
          },
          {
            name: 'x-razorpay-signature',
            in: 'header',
            required: true,
            schema: { type: 'string' },
          },
          {
            name: 'x-razorpay-event-id',
            in: 'header',
            required: false,
            schema: { type: 'string' },
          },
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': { schema: { type: 'object', additionalProperties: true } },
          },
        },
        responses: {
          '200': { description: 'Durably received or quarantined' },
          '400': { description: 'Invalid request' },
          '404': { description: 'Provider unavailable' },
          '503': { description: 'Persistence unavailable; retry delivery' },
        },
      },
    };
  document.components ??= {};
  document.components.schemas ??= {};
  const statuses = [400, 401, 403, 404, 409, 413, 415, 429, 500, 502, 503, 504];
  for (const status of statuses) {
    const defaultProblem = createProblem(status, 'request-id');
    const codes = [
      ...new Set([
        defaultProblem.code,
        ...(PROBLEM_CODES[status] ?? []),
        ...Object.entries(DOMAIN_ERROR_STATUS)
          .filter(([, value]) => value === status)
          .map(([code]) => code),
      ]),
    ].sort();
    document.components.schemas[`Problem${status}`] = {
      type: 'object',
      additionalProperties: false,
      required: ['type', 'title', 'status', 'code', 'detail', 'traceId'],
      properties: {
        type: { type: 'string', enum: ['about:blank'] },
        title: { type: 'string' },
        status: { type: 'integer', enum: [status] },
        code: { type: 'string', enum: codes },
        detail: { type: 'string' },
        traceId: { type: 'string' },
      },
    };
  }
  for (const [path, entry] of Object.entries(document.paths)) {
    // Webhook ingress deliberately uses its signed receive/quarantine contract.
    if (path.includes('/webhooks/')) continue;
    for (const method of ['get', 'post', 'put', 'patch', 'delete'] as const) {
      const operation = entry?.[method];
      if (!operation) continue;
      for (const status of statuses) {
        const existing = operation.responses[String(status)];
        if (existing && '$ref' in existing) continue;
        operation.responses[String(status)] = {
          ...existing,
          description: existing?.description ?? createProblem(status, '').title,
          content: {
            'application/problem+json': {
              schema: { $ref: `#/components/schemas/Problem${status}` },
            },
          },
        };
      }
    }
  }
  return document;
}

/** Production docs are disabled until authentication is available. */
export function registerOpenApi(app: INestApplication, env: Env): void {
  if (env.NODE_ENV === 'production') return;
  for (const surface of surfacesFor(env.APP_ROLE)) {
    const document = makeOpenApiDocument(app, surface);
    SwaggerModule.setup(`v1/${surface}/docs`, app, document);
  }
}
