import {
  CallHandler,
  ExecutionContext,
  HttpException,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { catchError, throwError, type Observable } from 'rxjs';
import { DOMAIN_ERROR_STATUS } from '../common/http/problem-codes.js';
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
        let status = Object.hasOwn(DOMAIN_ERROR_STATUS, code) ? DOMAIN_ERROR_STATUS[code] : 0;
        let safe = code;
        if (!status && ['23505', '23503', '23P01', '40001', '40P01'].includes(pg)) {
          status = 409;
          safe = 'RESOURCE_CONFLICT';
        } else if (!status && ['23514', '22P02', '22007', '22008'].includes(pg)) {
          status = 400;
          safe = 'INVALID_INPUT';
        }
        return throwError(() => (status ? new HttpException({ code: safe }, status) : error));
      }),
    );
  }
}
