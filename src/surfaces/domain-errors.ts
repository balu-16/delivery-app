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
            'ORDER_NOT_FOUND',
            'CART_NOT_FOUND',
            'PAYMENT_NOT_FOUND',
            'INVOICE_NOT_READY',
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
            'INVALID_MONEY',
            'INVALID_QUOTE_REQUEST',
            'COUPON_INVALID',
            'MIN_ORDER_NOT_MET',
            'MAX_ORDER_EXCEEDED',
            'INVALID_COUPON_CODE',
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
            'PRICE_CHANGED',
            'QUOTE_EXPIRED',
            'QUOTE_CONSUMED',
            'COUPON_EXPIRED',
            'COUPON_EXHAUSTED',
            'COUPON_NOT_ELIGIBLE',
            'COUPON_LIMIT_REACHED',
            'WALLET_INSUFFICIENT',
            'WALLET_DISABLED',
            'COD_NOT_ELIGIBLE',
            'COD_LIMIT_EXCEEDED',
            'AMOUNT_MISMATCH',
            'PAYMENT_STATE_INVALID',
            'REFUND_STATE_INVALID',
            'ILLEGAL_STATE_TRANSITION',
            'ADDRESS_CHANGE_NOT_ALLOWED',
            'CART_INTENT_CONSUMED',
            'REFUND_LIMIT_EXCEEDED',
            'PAYMENT_WINDOW_EXPIRED',
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
          ].includes(code)
        )
          status = 409;
        else if (
          [
            'INVALID_CURSOR',
            'INVALID_BATCH_SIZE',
            'INVALID_ATTEMPT',
            'INVALID_DEDUPE_INPUT',
            'INVALID_INSTANT',
            'INVALID_QUIET_WINDOW',
            'INVALID_SHORT_REASON',
            'INVALID_BATCH',
            'BATCH_REQUIRED',
            'INVALID_TARGET_TIME',
          ].includes(code)
        )
          status = 400;
        else if (['FULFILLMENT_DEPENDENCY_UNAVAILABLE', 'GATEWAY_OUTCOME_UNKNOWN'].includes(code))
          status = 503;
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
