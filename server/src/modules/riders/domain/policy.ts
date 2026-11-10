import { parseMoney } from '../../../common/money/money.js';
import type { EligibilityRejection } from '../contracts/riders.js';

/** A rider can go online only when the P1 profile is approved (D08). */
export function assertCanGoOnline(profileStatus: string): void {
  if (profileStatus === 'SUSPENDED') throw new Error('RIDER_SUSPENDED');
  if (profileStatus !== 'APPROVED') throw new Error('RIDER_NOT_APPROVED');
}

/**
 * Heartbeat staleness marks the rider unreachable for dispatch; the sweep
 * window (re-dispatch before pickup, escalation after) belongs to dispatch.
 */
export function isHeartbeatStale(
  lastHeartbeatAt: Date | null,
  at: Date,
  staleSeconds: number,
): boolean {
  if (!lastHeartbeatAt) return true;
  return at.getTime() - lastHeartbeatAt.getTime() > staleSeconds * 1000;
}

export function isLocationFresh(
  lastLocationAt: Date | null,
  at: Date,
  staleSeconds: number,
): boolean {
  if (!lastLocationAt) return false;
  return at.getTime() - lastLocationAt.getTime() <= staleSeconds * 1000;
}

/** Capacity check under rider status locks; limits arrive from config. */
export function hasTaskCapacity(activeTasks: number, maxConcurrentTasks: number): boolean {
  return activeTasks < maxConcurrentTasks;
}

/** COD cash limit: the new order must fit under the limit alongside held cash. */
export function passesCashLimit(
  heldPaise: bigint,
  codAmountPaise: string,
  limitPaise: string | null,
): boolean {
  if (limitPaise === null) return true;
  const amount = parseMoney(codAmountPaise);
  const limit = parseMoney(limitPaise);
  return heldPaise + amount <= limit;
}

export function rejectionFor(
  checks: readonly (EligibilityRejection | null)[],
): EligibilityResultPure {
  for (const check of checks) if (check) return { eligible: false, reason: check };
  return { eligible: true };
}
export interface EligibilityResultPure {
  eligible: boolean;
  reason?: EligibilityRejection;
}
