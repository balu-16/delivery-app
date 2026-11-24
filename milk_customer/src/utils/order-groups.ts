export type OrderGroup = 'all' | 'active' | 'delivered' | 'cancelled';

export const ACTIVE_STATUSES = new Set([
  'PENDING_PAYMENT',
  'CONFIRMED',
  'PICKING',
  'PACKED',
  'OUT_FOR_DELIVERY',
]);

export const DELIVERED_STATUSES = new Set(['DELIVERED']);
export const CANCELLED_STATUSES = new Set(['CANCELLED']);

export function orderGroupOf(status: string): OrderGroup | 'other' {
  if (ACTIVE_STATUSES.has(status)) return 'active';
  if (DELIVERED_STATUSES.has(status)) return 'delivered';
  if (CANCELLED_STATUSES.has(status)) return 'cancelled';
  return 'other';
}

export function belongsToGroup(status: string, group: OrderGroup): boolean {
  if (group === 'all') return true;
  if (group === 'active') return ACTIVE_STATUSES.has(status);
  if (group === 'delivered') return DELIVERED_STATUSES.has(status);
  if (group === 'cancelled') return CANCELLED_STATUSES.has(status);
  return true;
}

export function statusLabel(status: string): string {
  return status.replaceAll('_', ' ').toLowerCase();
}

export function isTrackable(status: string): boolean {
  return ['CONFIRMED', 'PICKING', 'PACKED', 'OUT_FOR_DELIVERY'].includes(status);
}

export function isCancellable(status: string): boolean {
  return ['CONFIRMED', 'PENDING_PAYMENT'].includes(status);
}

export const UUID_RE = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;
