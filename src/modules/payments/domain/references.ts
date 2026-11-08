import { uuidV7 } from '../../../common/ids/ids.js';
import type { OperationKind } from '../contracts/payments.js';

/**
 * Durable operation references double as gateway correlation values, so they
 * must satisfy the documented Razorpay constraints (retrieved 2026-11-06):
 * order `receipt` is at most 40 ASCII characters
 * (https://razorpay.com/docs/build/llm-docs/api/orders/create.md) and the
 * `X-Refund-Idempotency` key is at least 10 characters of
 * `[A-Za-z0-9_-]` (https://razorpay.com/docs/api/refunds/normal-refunds-idempotent/).
 * Neither is assumed to provide idempotency by itself (ADR 0007); they carry
 * our durable reference so lost responses can be matched through the
 * documented lookup paths.
 */
const REFERENCE_PATTERN = /^[a-z][a-z0-9-]{9,39}$/;

export type { OperationKind };
export function newOperationReference(prefix: 'order' | 'topup'): string {
  return `${prefix}-${uuidV7().replaceAll('-', '')}`;
}
export function newRefundReference(): string {
  return `refund-${uuidV7().replaceAll('-', '')}`;
}
export function validReference(reference: string): boolean {
  return REFERENCE_PATTERN.test(reference);
}
