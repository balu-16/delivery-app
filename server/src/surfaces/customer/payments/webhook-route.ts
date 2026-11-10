import { Readable } from 'node:stream';
import type { FastifyInstance, FastifyReply, FastifyRequest, preParsingHookHandler } from 'fastify';
import { ConfigService } from '../../../config/config.service.js';
import { createProblem } from '../../../common/http/problem.filter.js';
import type { PaymentWebhookIngest } from '../../../modules/payments/contracts/payments.js';

export const WEBHOOK_ROUTE = '/v1/customer/webhooks/payments/:gateway';
const SUPPORTED_GATEWAYS = ['fake', 'razorpay'];

interface RawRequest extends FastifyRequest {
  rawBody?: Buffer;
}

/**
 * Raw-body capture for the webhook route ONLY. fastify-raw-body cannot be
 * registered here because the composition root owns the server boot and Nest
 * registers routes before any queued plugin would load; a route-scoped
 * preParsing hook on the manually registered route captures the exact bytes
 * the provider signed (https://razorpay.com/docs/webhooks/validate-test/,
 * retrieved 2026-11-06: "webhook_body should be raw webhook request body").
 */
function captureRawBody(limitBytes: number): preParsingHookHandler {
  return (request, _reply, payload, done) => {
    const chunks: Buffer[] = [];
    let size = 0;
    payload.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size <= limitBytes) chunks.push(chunk);
    });
    payload.on('end', () => {
      (request as RawRequest).rawBody = size > limitBytes ? Buffer.alloc(0) : Buffer.concat(chunks);
      done(null, Readable.from((request as RawRequest).rawBody!));
    });
    payload.on('error', (error: Error) => done(error));
  };
}

/** Registers the public webhook ingress directly on the Fastify instance. */
export function registerWebhookRoute(
  instance: FastifyInstance,
  webhooks: PaymentWebhookIngest,
  config: ConfigService,
): void {
  const limitBytes = config.get('HTTP_BODY_LIMIT_BYTES');
  instance.route({
    method: 'POST',
    url: WEBHOOK_ROUTE,
    bodyLimit: limitBytes,
    preParsing: captureRawBody(limitBytes),
    handler: async (request: FastifyRequest, reply: FastifyReply) => {
      const gateway = (request.params as { gateway: string }).gateway;
      if (!SUPPORTED_GATEWAYS.includes(gateway) || gateway !== config.get('PAYMENTS_PROVIDER')) {
        reply.status(404).type('application/problem+json').send(createProblem(404, request.id));
        return;
      }
      const raw = (request as RawRequest).rawBody;
      if (raw === undefined) {
        reply.status(400).type('application/problem+json').send(createProblem(400, request.id));
        return;
      }
      try {
        const result = await webhooks.ingest({
          gateway,
          rawBody: new Uint8Array(raw),
          // A missing signature verifies as invalid and is quarantined with a
          // finding; the provider still receives a fast acknowledgement so a
          // tampered replay never triggers delivery retry loops (PAY-03).
          signature: headerOrEmpty(request, 'x-razorpay-signature'),
          eventIdHeader: headerOrNull(request, 'x-razorpay-event-id'),
        });
        return { received: result.accepted || result.duplicate };
      } catch {
        // The event could not be durably persisted (for example the database
        // is unreachable): fail the delivery so the provider retries later.
        reply.status(503).type('application/problem+json').send(createProblem(503, request.id));
        return;
      }
    },
  });
}
function headerOrEmpty(request: FastifyRequest, name: string): string {
  return headerOrNull(request, name) ?? '';
}
function headerOrNull(request: FastifyRequest, name: string): string | null {
  const value = request.headers[name];
  return typeof value === 'string' ? value : null;
}
