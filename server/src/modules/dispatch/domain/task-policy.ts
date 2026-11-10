import type { DeliveryTaskStatus } from '../contracts/tasks.js';

/** Guarded transition (pure); storage/history/events belong to the caller. */
function transition(current: DeliveryTaskStatus, next: DeliveryTaskStatus): DeliveryTaskStatus {
  if (!DELIVERY_TASK_TRANSITIONS[current].includes(next))
    throw new Error('ILLEGAL_STATE_TRANSITION');
  return next;
}

/**
 * Delivery task machine (11.3). ASSIGNED/AT_STORE return to UNASSIGNED on
 * rider drop or unreachability with attempt_no+1 (D21); after pickup custody
 * is never auto-reassigned — post-pickup problems escalate audited.
 */
export const DELIVERY_TASK_TRANSITIONS: Readonly<
  Record<DeliveryTaskStatus, readonly DeliveryTaskStatus[]>
> = {
  UNASSIGNED: ['OFFERED', 'CANCELLED'],
  OFFERED: ['UNASSIGNED', 'ASSIGNED', 'CANCELLED'],
  ASSIGNED: ['AT_STORE', 'UNASSIGNED', 'FAILED', 'CANCELLED'],
  AT_STORE: ['PICKED_UP', 'UNASSIGNED', 'FAILED', 'CANCELLED'],
  PICKED_UP: ['ARRIVED', 'FAILED'],
  ARRIVED: ['DELIVERED', 'FAILED'],
  DELIVERED: [],
  FAILED: [],
  CANCELLED: [],
};

export function transitionTask(
  current: DeliveryTaskStatus,
  next: DeliveryTaskStatus,
): DeliveryTaskStatus {
  return transition(current, next);
}

/** Custody window for rider contact access (ASSIGNED..ARRIVED, GEO-04). */
export function contactVisible(status: DeliveryTaskStatus): boolean {
  return ['ASSIGNED', 'AT_STORE', 'PICKED_UP', 'ARRIVED'].includes(status);
}

/**
 * Live customer visibility window (23.4): between ASSIGNED and DELIVERED.
 * Terminal states revoke live location visibility (RTN-01).
 */
export function locationVisible(status: DeliveryTaskStatus): boolean {
  return ['ASSIGNED', 'AT_STORE', 'PICKED_UP', 'ARRIVED'].includes(status);
}

export function assertOperationReference(reference: string): void {
  if (!reference || reference.length > 150) throw new Error('INVALID_INPUT');
}

export function assertFailReason(reason: string): void {
  if (!reason || reason.length > 300) throw new Error('INVALID_INPUT');
}

/**
 * Geofence policy (23.3): a farther-than-configured arrival is accepted but
 * flagged, never hard-blocked (GPS is noisy).
 */
export function geofenceFlag(
  reportedMetres: number | null,
  thresholdMetres: number,
): number | null {
  if (reportedMetres === null) return null;
  return reportedMetres > thresholdMetres ? Math.trunc(reportedMetres) : null;
}

/** Fail split (D21/23.3): before pickup re-dispatch, after custody FAILED. */
export function failEndsCustody(status: DeliveryTaskStatus): boolean {
  return status === 'PICKED_UP' || status === 'ARRIVED';
}
