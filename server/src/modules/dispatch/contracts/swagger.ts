import { applyDecorators } from '@nestjs/common';
import { ApiHeader, ApiProperty, ApiResponse } from '@nestjs/swagger';
import {
  CallHandler,
  ExecutionContext,
  HttpException,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { catchError, throwError, type Observable } from 'rxjs';
import { ProblemDto } from '../../identity/contracts/swagger.js';

export class RiderLocationSnapshotView {
  @ApiProperty() lat!: number;
  @ApiProperty() lng!: number;
  @ApiProperty({ format: 'date-time' }) at!: string;
}
export class EtaRangeView {
  @ApiProperty({ minimum: 0 }) minMinutes!: number;
  @ApiProperty({ minimum: 0 }) maxMinutes!: number;
}
export class DeliveryTaskView {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) orderId!: string;
  @ApiProperty({ format: 'uuid' }) storeId!: string;
  @ApiProperty({
    enum: [
      'UNASSIGNED',
      'OFFERED',
      'ASSIGNED',
      'AT_STORE',
      'PICKED_UP',
      'ARRIVED',
      'DELIVERED',
      'FAILED',
      'CANCELLED',
    ],
  })
  status!: string;
  @ApiProperty({ type: String, nullable: true, format: 'uuid' }) riderId!: string | null;
  @ApiProperty() attemptNo!: number;
  @ApiProperty({ type: String, nullable: true, format: 'date-time' }) pickupAt!: string | null;
  @ApiProperty({ type: String, nullable: true, format: 'date-time' }) arrivedStoreAt!:
    string | null;
  @ApiProperty({ type: String, nullable: true, format: 'date-time' })
  arrivedCustomerAt!: string | null;
  @ApiProperty({ type: String, nullable: true, format: 'date-time' }) deliveredAt!: string | null;
  @ApiProperty({ type: String, nullable: true }) codAmountPaise!: string | null;
  @ApiProperty({ type: String, nullable: true }) handoverCode!: string | null;
  @ApiProperty({ pattern: '^[1-9]\\d*$' }) version!: string;
}
export class OfferView {
  @ApiProperty({ format: 'uuid' }) offerId!: string;
  @ApiProperty({ format: 'uuid' }) taskId!: string;
  @ApiProperty({ format: 'uuid' }) orderId!: string;
  @ApiProperty({ format: 'uuid' }) storeId!: string;
  @ApiProperty() attemptNo!: number;
  @ApiProperty({ format: 'date-time' }) expiresAt!: string;
  @ApiProperty({ type: String, nullable: true }) codAmountPaise!: string | null;
}
export class OfferPageView {
  @ApiProperty({ type: [OfferView] }) items!: OfferView[];
}
export class OrderTrackingView {
  @ApiProperty({ format: 'uuid' }) orderId!: string;
  @ApiProperty() taskStatus!: string;
  @ApiProperty() attemptNo!: number;
  @ApiProperty({ type: RiderLocationSnapshotView, nullable: true })
  riderLocation!: RiderLocationSnapshotView | null;
  @ApiProperty({ type: EtaRangeView, nullable: true }) eta!: EtaRangeView | null;
}
export class DeliveryCodeView {
  @ApiProperty({ pattern: '^\\d{4}$' }) code!: string;
  @ApiProperty() keyVersion!: number;
}
export class CodCollectResultView {
  @ApiProperty({ format: 'uuid' }) orderId!: string;
  @ApiProperty({ pattern: '^\\d+$' }) collectedPaise!: string;
  @ApiProperty({ type: String, nullable: true }) expectedPaise!: string | null;
  @ApiProperty() mismatch!: boolean;
}
export class WrongAddressFlagView {
  @ApiProperty({ format: 'uuid' }) flagId!: string;
}
export class WrongAddressResolutionView extends WrongAddressFlagView {
  @ApiProperty({ enum: ['FAILED'] }) status!: 'FAILED';
}
export class ContactAttemptView {
  @ApiProperty({ format: 'date-time' }) recordedAt!: string;
}

export function DeliveryIdempotencyHeader(): MethodDecorator {
  return ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    description: 'Retained key scoped to the actor and dispatch operation',
    schema: { type: 'string', minLength: 1, maxLength: 150 },
  });
}

const STATUS_400 = [
  'INVALID_INPUT',
  'DELIVERY_CODE_INVALID',
  'DELIVERY_PROOF_REQUIRED',
  'INVALID_MONEY',
  'INVALID_TIMESTAMP',
  'BATCH_TOO_LARGE',
  'INVALID_PAGE',
];
const STATUS_404 = ['RESOURCE_NOT_FOUND', 'ORDER_NOT_FOUND', 'DELIVERY_CODE_NOT_READY'];
const STATUS_409 = [
  'OFFER_NO_LONGER_AVAILABLE',
  'OFFER_EXPIRED',
  'RIDER_OFFLINE',
  'RIDER_AT_CAPACITY',
  'CASH_LIMIT_EXCEEDED',
  'TASK_STATE_INVALID',
  'HANDOVER_NOT_VERIFIED',
  'DELIVERY_CODE_LOCKED',
  'COD_NOT_COLLECTED',
  'COD_AMOUNT_MISMATCH',
  'COD_NOT_APPLICABLE',
  'ILLEGAL_STATE_TRANSITION',
  'CONCURRENT_MODIFICATION',
  'IDEMPOTENCY_KEY_REUSED',
  'REQUEST_IN_PROGRESS',
  'RIDER_SUSPENDED',
  'RIDER_NOT_APPROVED',
  'DELIVERY_WAIT_REQUIRED',
  'DELIVERY_CONTACT_ATTEMPTS_REQUIRED',
  'ADMIN_RESOLUTION_REQUIRED',
];
const STATUS_503 = ['DISPATCH_DEPENDENCY_UNAVAILABLE'];

/**
 * Maps dispatch/riders/tracking domain codes onto problem statuses. Local to
 * the P8 surfaces because the shared DomainErrorInterceptor's catalogue is
 * owned by the main agent; unknown codes fall through unchanged.
 */
@Injectable()
export class DeliveryErrorInterceptor implements NestInterceptor {
  intercept(_context: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next.handle().pipe(
      catchError((error: unknown) => {
        if (error instanceof HttpException) return throwError(() => error);
        const code = error instanceof Error ? error.message : '';
        let status = 0;
        if (STATUS_400.includes(code)) status = 400;
        else if (STATUS_404.includes(code)) status = 404;
        else if (STATUS_409.includes(code)) status = 409;
        else if (STATUS_503.includes(code)) status = 503;
        return throwError(() => (status ? new HttpException({ code }, status) : error));
      }),
    );
  }
}

/** Shared contract for the rider dispatch surface; declared failures stay safe. */
export function DeliveryApiErrors(): ClassDecorator {
  return applyDecorators(
    ...[
      [400, 'Invalid request'],
      [401, 'Authentication required'],
      [403, 'Role not permitted'],
      [404, 'Task, offer or order not found'],
      [409, 'Offer, custody, code, COD or idempotency conflict'],
      [429, 'Rate limited; retry after the indicated delay'],
      [503, 'Dispatch dependency unavailable'],
    ].map(([status, description]) =>
      ApiResponse({ status: Number(status), description: String(description), type: ProblemDto }),
    ),
  );
}
