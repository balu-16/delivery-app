import type { AttemptState, RefundState } from '../contracts/payments.js';

/**
 * Payment attempt and refund state machines (D18). Attempts are modelled
 * separately from order funding: a verified capture may supersede an earlier
 * failure only while funding stays valid, and stale failures can never undo a
 * capture. UNKNOWN records ambiguity from lost responses or unreadable events.
 * The transition tables are inlined (pure domain may depend only on its
 * contracts and pure common primitives).
 */
export const ATTEMPT_STATES = ['CREATED', 'AUTHORIZED', 'CAPTURED', 'FAILED', 'UNKNOWN'] as const;

const ATTEMPT_TRANSITIONS: Readonly<Record<AttemptState, readonly AttemptState[]>> = {
  CREATED: ['AUTHORIZED', 'CAPTURED', 'FAILED', 'UNKNOWN'],
  AUTHORIZED: ['CAPTURED', 'FAILED', 'UNKNOWN'],
  // Captured is money-affecting: it can never regress to FAILED; UNKNOWN keeps
  // reconciliation open (duplicate captures are findings, not downgrades).
  CAPTURED: ['UNKNOWN'],
  FAILED: ['CAPTURED'],
  UNKNOWN: ['CAPTURED', 'FAILED'],
};

export function transitionAttempt(current: AttemptState, next: AttemptState): AttemptState {
  if (!ATTEMPT_STATES.includes(current) || !ATTEMPT_TRANSITIONS[current].includes(next))
    throw new Error('PAYMENT_STATE_INVALID');
  return next;
}

export const REFUND_STATES = ['PENDING', 'PROCESSED', 'FAILED', 'UNKNOWN'] as const;

const REFUND_TRANSITIONS: Readonly<Record<RefundState, readonly RefundState[]>> = {
  PENDING: ['PROCESSED', 'FAILED', 'UNKNOWN'],
  // A wallet fallback requires the ORIGINAL refund outcome to be definitively
  // terminal (ADR 0008): UNKNOWN can only resolve to PROCESSED or FAILED.
  UNKNOWN: ['PROCESSED', 'FAILED'],
  PROCESSED: [],
  FAILED: [],
};

export function transitionRefund(current: RefundState, next: RefundState): RefundState {
  if (!REFUND_STATES.includes(current) || !REFUND_TRANSITIONS[current].includes(next))
    throw new Error('REFUND_STATE_INVALID');
  return next;
}

export const INBOX_STATES = ['PENDING', 'PROCESSING', 'PROCESSED', 'QUARANTINED'] as const;
export type InboxState = (typeof INBOX_STATES)[number];

export type QuarantineReason =
  | 'SIGNATURE_INVALID'
  | 'CHANGED_BODY'
  | 'AMOUNT_MISMATCH'
  | 'CURRENCY_MISMATCH'
  | 'UNMAPPED_EVENT'
  | 'UNPARSEABLE';

/** Bounded escalation: an event that keeps failing stops after this many tries. */
export const MAX_INBOX_ATTEMPTS = 20;

/**
 * Refund-recovery escalation bound: after this many external attempts a
 * still-unresolved refund stops automatic retries and a finding routes it to
 * admin review (PAY-06/07). Structural safety bound; P12 may move it to
 * app_config with an audited change.
 */
export const MAX_REFUND_RECOVERY_ATTEMPTS = 12;

/**
 * Advisory checkout velocity default (fraud signals v1, Section 26): orders
 * per user per hour that record a review signal. Advisory only (D25); P12
 * owns the configurable policy.
 */
export const FRAUD_VELOCITY_ORDERS_PER_HOUR = 20;

export function findingSeverity(
  reason: QuarantineReason | 'DUPLICATE_CAPTURE',
): 'WARN' | 'CRITICAL' {
  switch (reason) {
    case 'SIGNATURE_INVALID':
    case 'CHANGED_BODY':
    case 'AMOUNT_MISMATCH':
    case 'CURRENCY_MISMATCH':
    case 'DUPLICATE_CAPTURE':
      return 'CRITICAL';
    default:
      return 'WARN';
  }
}
