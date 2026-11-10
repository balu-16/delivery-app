/**
 * Webhook payload parsing (pure domain). The provider signs raw bytes; once
 * the signature is verified the inbox may parse JSON. Documented payload shape:
 * `{ event, contains, payload: { payment: { entity: {...} }, refund: { entity: {...} } } }`
 * per https://razorpay.com/docs/webhooks/ and the payments/refunds API entity
 * fields (id, order_id, payment_id, amount, currency, status), retrieved
 * 2026-11-06. Unknown shapes are quarantined as UNPARSEABLE, never guessed.
 */
export const HANDLED_EVENT_TYPES = [
  'payment.authorized',
  'payment.captured',
  'payment.failed',
  'order.paid',
  'refund.processed',
  'refund.failed',
] as const;
export type HandledEventType = (typeof HANDLED_EVENT_TYPES)[number] | 'UNMAPPED';
export interface GatewayEventPayment {
  paymentId: string;
  gatewayOrderId: string | null;
  amountPaise: string | null;
  currency: string | null;
  status: string | null;
}
export interface GatewayEventRefund {
  refundId: string;
  gatewayPaymentId: string | null;
  amountPaise: string | null;
  status: string | null;
}
export interface GatewayEvent {
  type: HandledEventType;
  payment: GatewayEventPayment | null;
  refund: GatewayEventRefund | null;
}
export type ParseResult = { kind: 'ok'; event: GatewayEvent } | { kind: 'unparseable' };

function entityField(entity: Record<string, unknown>, field: string): string | null {
  const value = entity[field];
  return typeof value === 'string' && value ? value : null;
}
function amountField(entity: Record<string, unknown>): string | null {
  const value = entity['amount'];
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value);
  if (typeof value === 'string' && /^\d+$/.test(value)) return value;
  return null;
}
function entityAt(payload: Record<string, unknown>, key: string): Record<string, unknown> | null {
  const branch = payload[key];
  if (branch === null || typeof branch !== 'object' || Array.isArray(branch)) return null;
  const entity = (branch as Record<string, unknown>)['entity'];
  if (entity === null || typeof entity !== 'object' || Array.isArray(entity)) return null;
  return entity as Record<string, unknown>;
}
function paymentFrom(entity: Record<string, unknown> | null): GatewayEventPayment | null {
  if (!entity) return null;
  const paymentId = entityField(entity, 'id');
  if (!paymentId) return null;
  return {
    paymentId,
    gatewayOrderId: entityField(entity, 'order_id'),
    amountPaise: amountField(entity),
    currency: entityField(entity, 'currency'),
    status: entityField(entity, 'status'),
  };
}
function refundFrom(entity: Record<string, unknown> | null): GatewayEventRefund | null {
  if (!entity) return null;
  const refundId = entityField(entity, 'id');
  if (!refundId) return null;
  return {
    refundId,
    gatewayPaymentId: entityField(entity, 'payment_id'),
    amountPaise: amountField(entity),
    status: entityField(entity, 'status'),
  };
}

/** Tolerant parse: a signed body must still be persisted even when unusable. */
export function parseGatewayEvent(raw: string): ParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return { kind: 'unparseable' };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
    return { kind: 'unparseable' };
  const body = parsed as Record<string, unknown>;
  const eventName = body['event'];
  if (typeof eventName !== 'string' || !eventName) return { kind: 'unparseable' };
  const payload = body['payload'];
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload))
    return { kind: 'unparseable' };
  const branch = payload as Record<string, unknown>;
  const type: HandledEventType = (HANDLED_EVENT_TYPES as readonly string[]).includes(eventName)
    ? (eventName as HandledEventType)
    : 'UNMAPPED';
  const payment =
    type.startsWith('payment.') || type === 'order.paid'
      ? paymentFrom(entityAt(branch, 'payment'))
      : null;
  const refund = type.startsWith('refund.') ? refundFrom(entityAt(branch, 'refund')) : null;
  if (type !== 'UNMAPPED' && !payment && !refund) return { kind: 'unparseable' };
  return { kind: 'ok', event: { type, payment, refund } };
}
