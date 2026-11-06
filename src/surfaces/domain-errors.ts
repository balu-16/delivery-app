import {
  CallHandler,
  ExecutionContext,
  HttpException,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { catchError, throwError, type Observable } from 'rxjs';
/** Translate only known domain/provider failures; never expose SQL or vendor messages. */
@Injectable()
export class DomainErrorInterceptor implements NestInterceptor {
  intercept(_context: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next.handle().pipe(
      catchError((error: unknown) => {
        if (error instanceof HttpException) return throwError(() => error);
        const code = error instanceof Error ? error.message : '';
        const pg =
          typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : '';
        let status = 0,
          safe = code;
        if (code === 'FORBIDDEN') status = 403;
        else if (
          [
            'RESOURCE_NOT_FOUND',
            'MEDIA_NOT_FOUND',
            'ADDRESS_NOT_SERVICEABLE',
            'STORE_NOT_FOUND',
          ].includes(code)
        )
          status = 404;
        else if (
          [
            'INVALID_CATALOG',
            'INVALID_GST',
            'INVALID_PRICE',
            'INVALID_PRICE_TIME',
            'INVALID_MEDIA',
            'INVALID_SEARCH_QUERY',
            'INVALID_APPROVAL',
            'INVALID_PAGE',
            'INVALID_CSV',
            'IMPORT_TOO_MANY_ROWS',
            'INVALID_INPUT',
            'INVALID_QUANTITY',
          ].includes(code)
        )
          status = 400;
        else if (
          [
            'PRODUCT_NOT_PUBLISHABLE',
            'CATALOG_IN_USE',
            'APPROVAL_REQUIRED',
            'APPROVAL_INVALID',
            'APPROVAL_POLICY_CHANGED',
            'CONCURRENT_MODIFICATION',
            'IDEMPOTENCY_KEY_REUSED',
            'REQUEST_IN_PROGRESS',
            'INVENTORY_INSUFFICIENT',
            'INVENTORY_RESERVED',
            'RESERVATION_STATE_INVALID',
            'BATCH_NOT_ELIGIBLE',
            'RETURN_QUANTITY_EXCEEDED',
            'RESOURCE_CONFLICT',
            'RECEIPT_REQUIRED',
            'REPORT_NOT_READY',
          ].includes(code)
        )
          status = 409;
        else if (code === 'IMPORT_TOO_LARGE') status = 413;
        else if (['ExternalServiceUnavailable', 'ExternalServiceTimeout'].includes(code))
          status = 503;
        else if (['23505', '23503', '23P01', '40001', '40P01'].includes(pg)) {
          status = 409;
          safe = 'RESOURCE_CONFLICT';
        } else if (['23514', '22P02', '22007', '22008'].includes(pg)) {
          status = 400;
          safe = 'INVALID_INPUT';
        }
        return throwError(() => (status ? new HttpException({ code: safe }, status) : error));
      }),
    );
  }
}
