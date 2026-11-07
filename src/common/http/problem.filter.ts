import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Logger } from 'pino';

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
  const codes: Record<number, readonly string[]> = {
    400: [
      'INVALID_COORDINATES',
      'INVALID_PINCODE',
      'INVALID_CONTACT_PHONE',
      'INVALID_ADDRESS',
      'INVALID_VERSION',
      'INVALID_ZONE',
      'INVALID_ZONE_GEOMETRY',
      'ZONE_OUTSIDE_BOUNDS_OR_AREA',
      'INVALID_TARGET_TIME',
      'MATRIX_BUDGET_EXCEEDED',
      'INVALID_BOOTSTRAP_IDENTITY',
      'INVALID_EMAIL',
      'INVALID_CONSENT_VERSION',
      'INVALID_CONFIG_VALUE',
      'INVALID_CONFIG_KEY',
      'INVALID_FLAG',
      'INVALID_APPROVAL',
      'INVALID_WORKFORCE_INPUT',
      'ROLE_NOT_MANAGED',
      'INVALID_SEARCH',
      'INVALID_RIDER_PROFILE',
      'INVALID_DOCUMENT',
      'INVALID_MEDIA',
      'INVALID_HOURS',
      'INVALID_PAUSE_REASON',
      'INVALID_INPUT',
      'INVALID_PROFILE',
      'REVIEW_REASON_REQUIRED',
      'INVALID_SEARCH_QUERY',
      'INVALID_CATALOG',
      'INVALID_GST',
      'INVALID_PRICE',
      'INVALID_PRICE_TIME',
      'INVALID_QUANTITY',
      'INVALID_PAGE',
      'INVALID_CSV',
      'IMPORT_TOO_MANY_ROWS',
    ],
    401: ['INVALID_TOKEN'],
    403: [
      'PROFILE_NOT_INITIALIZED',
      'ACCOUNT_DISABLED',
      'RIDER_NOT_APPROVED',
      'FORBIDDEN',
      'CONSENT_REQUIRED',
      'EMAIL_NOT_VERIFIED',
    ],
    404: [
      'ADDRESS_NOT_FOUND',
      'STORE_NOT_FOUND',
      'ZONE_NOT_FOUND',
      'PLACE_NOT_FOUND',
      'DOCUMENT_NOT_FOUND',
      'RESOURCE_NOT_FOUND',
      'USER_NOT_FOUND',
      'MEDIA_NOT_FOUND',
      'ADDRESS_NOT_SERVICEABLE',
    ],
    409: [
      'ADDRESS_LIMIT_REACHED',
      'CONCURRENT_MODIFICATION',
      'ZONE_STORE_IMMUTABLE',
      'ADDRESS_CHANGE_NOT_ALLOWED',
      'IDEMPOTENCY_KEY_REUSED',
      'REQUEST_IN_PROGRESS',
      'LAST_SUPER_ADMIN',
      'CANNOT_DISABLE_SELF',
      'APPROVAL_INVALID',
      'APPROVAL_POLICY_CHANGED',
      'PROVISIONING_INPUT_CONFLICT',
      'ROLE_NOT_ASSIGNED',
      'RESOURCE_CONFLICT',
      'STORE_CITY_IMMUTABLE',
      'DOCUMENT_STATE_INVALID',
      'PRODUCT_NOT_PUBLISHABLE',
      'CATALOG_IN_USE',
      'APPROVAL_REQUIRED',
      'INVENTORY_INSUFFICIENT',
      'INVENTORY_RESERVED',
      'RESERVATION_STATE_INVALID',
      'RECEIPT_REQUIRED',
      'BATCH_NOT_ELIGIBLE',
      'RETURN_QUANTITY_EXCEEDED',
      'REPORT_NOT_READY',
      'PICK_TASK_STATE_INVALID',
      'NOT_TASK_OWNER',
      'ITEM_ALREADY_RESOLVED',
      'PICKER_AT_CAPACITY',
      'PICK_TASK_INCOMPLETE',
      'PICK_TASK_NOT_COMPLETE',
      'WRONG_ITEM',
      'SUBSTITUTION_DISABLED',
      'SUBSTITUTION_NOT_PERMITTED',
      'SUBSTITUTION_STATE_INVALID',
      'HANDOVER_CODE_INVALID',
      'HANDOVER_LOCKED',
      'HANDOVER_NOT_READY',
    ],
    413: ['IMPORT_TOO_LARGE'],
    502: ['ExternalServiceRejected'],
    503: [
      'ExternalServiceUnavailable',
      'ExternalServiceTimeout',
      'FULFILLMENT_DEPENDENCY_UNAVAILABLE',
    ],
  };
  const [title, fallback] = names[status] ?? ['Internal Server Error', 'INTERNAL_ERROR'];
  const code =
    typeof supplied === 'string' && codes[status]?.includes(supplied) ? supplied : fallback;
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
