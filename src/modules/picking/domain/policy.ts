import { parseMoney } from '../../../common/money/money.js';
import type { PickItemStatus, PickTaskStatus, ShortReason } from '../contracts/tasks.js';

const MAX_PG_BIGINT = 9_223_372_036_854_775_807n;

/** Quantities are whole saleable units as canonical decimal strings. */
export function pickQuantity(value: string, allowZero = false): bigint {
  let parsed: bigint;
  try {
    parsed = parseMoney(value);
  } catch {
    throw new Error('INVALID_QUANTITY');
  }
  if (parsed < 0n || parsed > MAX_PG_BIGINT) throw new Error('INVALID_QUANTITY');
  if (!allowZero && parsed === 0n) throw new Error('INVALID_QUANTITY');
  return parsed;
}

/** Guarded transition (pure; the shared kit is not importable from domain code). */
function transition<State extends string>(
  current: State,
  next: State,
  allowed: Readonly<Record<State, readonly State[]>>,
): State {
  const row = allowed[current];
  if (!row || !row.includes(next)) throw new Error('INVALID_STATE_TRANSITION');
  return next;
}

/**
 * Pure pick-task policy; storage, history and events belong to the caller's
 * transaction. All timestamps in guards must be sampled after database locks.
 */
export const PICK_TASK_TRANSITIONS: Readonly<Record<PickTaskStatus, readonly PickTaskStatus[]>> = {
  PENDING: ['ASSIGNED', 'CANCELLED'],
  // Reassignment can send a task back to the pool with progress preserved.
  ASSIGNED: ['IN_PROGRESS', 'PENDING', 'ASSIGNED', 'CANCELLED'],
  IN_PROGRESS: ['COMPLETED', 'CANCELLED', 'IN_PROGRESS'],
  COMPLETED: [],
  CANCELLED: [],
};
export function transitionTask(current: PickTaskStatus, next: PickTaskStatus): PickTaskStatus {
  return transition(current, next, PICK_TASK_TRANSITIONS);
}

/**
 * Item transitions: shorts and substitutions are terminal before completion
 * (the financial adjustment is computed once at completion, so states cannot
 * be unwound after a picker resolved them).
 */
export const PICK_ITEM_TRANSITIONS: Readonly<Record<PickItemStatus, readonly PickItemStatus[]>> = {
  PENDING: ['PICKED', 'SHORT', 'SUBSTITUTED'],
  PICKED: ['PICKED', 'SHORT', 'SUBSTITUTED'],
  SHORT: ['SHORT'],
  SUBSTITUTED: ['SUBSTITUTED'],
};
export function transitionItem(current: PickItemStatus, next: PickItemStatus): PickItemStatus {
  return transition(current, next, PICK_ITEM_TRANSITIONS);
}

export const SHORT_REASONS: readonly ShortReason[] = [
  'OUT_OF_STOCK',
  'DAMAGED',
  'EXPIRED',
  'NOT_FOUND',
];
export function assertShortReason(reason: string): asserts reason is ShortReason {
  if (!SHORT_REASONS.includes(reason as ShortReason)) throw new Error('INVALID_SHORT_REASON');
}

/** Scans are matched case-insensitively after trimming; a missing expected barcode fails closed. */
export function assertScanMatch(expectedBarcode: string | null, scanned: string): void {
  const want = (expectedBarcode ?? '').trim().toUpperCase();
  const got = scanned.trim().toUpperCase();
  if (!want || !got || got.length > 100 || got !== want) throw new Error('WRONG_ITEM');
}

/** Quantities are whole saleable units; a picked line can never exceed the expected quantity. */
export function assertPickedQuantity(expectedQty: bigint, pickedQty: bigint): void {
  if (pickedQty <= 0n || pickedQty > expectedQty) throw new Error('INVALID_QUANTITY');
}

/** A short resolves the unpicked remainder; it cannot exceed what is still outstanding. */
export function shortQuantity(expectedQty: bigint, pickedQty: bigint): bigint {
  const outstanding = expectedQty - pickedQty;
  if (outstanding <= 0n) throw new Error('ITEM_ALREADY_RESOLVED');
  return outstanding;
}

export function assertOperationReference(reference: string): void {
  if (!reference || reference.length > 150) throw new Error('INVALID_INPUT');
}

/** Completion requires every item to be resolved (picked, short or substituted). */
export function canComplete(items: readonly { status: PickItemStatus }[]): boolean {
  return items.length > 0 && items.every((item) => item.status !== 'PENDING');
}
