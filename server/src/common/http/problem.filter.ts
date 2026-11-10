import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Logger } from 'pino';
import { DOMAIN_ERROR_STATUS, PROBLEM_CODES } from './problem-codes.js';

/** Preserve declared application codes without reflecting arbitrary vendor messages. */
export function createProblem(status: number, traceId: string, supplied?: unknown) {
  const names: Record<number, [string, string]> = {
    400: ['Bad Request', 'BAD_REQUEST'],
    401: ['Unauthorized', 'UNAUTHORIZED'],
    403: ['Forbidden', 'FORBIDDEN'],
    404: ['Not Found', 'NOT_FOUND'],
    405: ['Method Not Allowed', 'METHOD_NOT_ALLOWED'],
    408: ['Request Timeout', 'REQUEST_TIMEOUT'],
    409: ['Conflict', 'CONFLICT'],
    413: ['Payload Too Large', 'PAYLOAD_TOO_LARGE'],
    415: ['Unsupported Media Type', 'UNSUPPORTED_MEDIA_TYPE'],
    429: ['Too Many Requests', 'RATE_LIMITED'],
    502: ['Bad Gateway', 'BAD_GATEWAY'],
    503: ['Service Unavailable', 'SERVICE_UNAVAILABLE'],
    504: ['Gateway Timeout', 'GATEWAY_TIMEOUT'],
  };

  const [title, fallback] = names[status] ?? ['Internal Server Error', 'INTERNAL_ERROR'];
  const code =
    typeof supplied === 'string' &&
    (PROBLEM_CODES[status]?.includes(supplied) ||
      (Object.hasOwn(DOMAIN_ERROR_STATUS, supplied) && DOMAIN_ERROR_STATUS[supplied] === status))
      ? supplied
      : fallback;
  return { type: 'about:blank', title, status, code, detail: title, traceId };
}

/** Stable problem response without reflecting validation or infrastructure details. */
@Catch()
export class ProblemFilter implements ExceptionFilter {
  constructor(private readonly logger?: Pick<Logger, 'error'>) {}
  catch(error: unknown, host: ArgumentsHost): void {
    const context = host.switchToHttp();
    const request = context.getRequest<FastifyRequest>();
    const reply = context.getResponse<FastifyReply>();
    const status =
      error instanceof HttpException ? error.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;
    const response = error instanceof HttpException ? error.getResponse() : undefined;
    const supplied =
      response && typeof response === 'object' && 'code' in response ? response.code : undefined;
    const problem = createProblem(status, request.id, supplied);
    if (status >= 500)
      this.logger?.error(
        { traceId: request.id, method: request.method, status, code: problem.code },
        'HTTP request failed',
      );
    reply.status(status).type('application/problem+json').send(problem);
  }
}
