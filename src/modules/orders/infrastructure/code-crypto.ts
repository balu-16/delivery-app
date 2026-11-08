import { createHmac, timingSafeEqual } from 'node:crypto';
import { codeFromNonce } from '../domain/delivery-code-policy.js';
function key(secret: string, purpose: 'derive' | 'verify', version: number) {
  return createHmac('sha256', secret).update(`delivery-code:${purpose}:v${version}`).digest();
}
export function deriveCode(secret: string, orderId: string, version = 1): string {
  return codeFromNonce(
    createHmac('sha256', key(secret, 'derive', version))
      .update(`v${version}:${orderId}`)
      .digest(),
  );
}
export function deriveVerifier(
  secret: string,
  _orderId: string,
  code: string,
  version = 1,
): Buffer {
  return createHmac('sha256', key(secret, 'verify', version))
    .update(code)
    .digest();
}
export function verifiersMatch(a: Buffer, b: Buffer) {
  return a.length === b.length && timingSafeEqual(a, b);
}
export function assertDeliveryCodeShape(code: string) {
  if (!/^\d{4}$/.test(code)) throw new Error('DELIVERY_CODE_INVALID');
}
