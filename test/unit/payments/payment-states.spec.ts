import {
  ATTEMPT_STATES,
  REFUND_STATES,
  findingSeverity,
  transitionAttempt,
  transitionRefund,
} from '../../../src/modules/payments/domain/states.js';
import type {
  AttemptState,
  RefundState,
} from '../../../src/modules/payments/contracts/payments.js';

/**
 * Exhaustive transition-matrix coverage for the D18 payment state machines:
 * every legal edge, every illegal edge (typed 409s), and every quarantine
 * severity branch. Payment attempt rows and refund rows never regress a
 * capture and never leave UNKNOWN without a definitive terminal outcome.
 */
describe('payment attempt state machine (D18)', () => {
  const legal: Record<AttemptState, readonly AttemptState[]> = {
    CREATED: ['AUTHORIZED', 'CAPTURED', 'FAILED', 'UNKNOWN'],
    AUTHORIZED: ['CAPTURED', 'FAILED', 'UNKNOWN'],
    CAPTURED: ['UNKNOWN'],
    FAILED: ['CAPTURED'],
    UNKNOWN: ['CAPTURED', 'FAILED'],
  };
  it('accepts exactly the documented legal edges', () => {
    for (const [from, targets] of Object.entries(legal)) {
      for (const to of targets)
        expect(transitionAttempt(from as AttemptState, to as AttemptState)).toBe(to);
    }
  });
  it('rejects every other edge with PAYMENT_STATE_INVALID, including capture regressions', () => {
    for (const from of ATTEMPT_STATES)
      for (const to of ATTEMPT_STATES)
        if (!legal[from].includes(to))
          expect(() => transitionAttempt(from, to)).toThrow('PAYMENT_STATE_INVALID');
  });
});

describe('refund state machine (D18/ADR 0008)', () => {
  const legal: Record<RefundState, readonly RefundState[]> = {
    PENDING: ['PROCESSED', 'FAILED', 'UNKNOWN'],
    PROCESSED: [],
    FAILED: [],
    UNKNOWN: ['PROCESSED', 'FAILED'],
  };
  it('accepts exactly the documented legal edges', () => {
    for (const [from, targets] of Object.entries(legal)) {
      for (const to of targets)
        expect(transitionRefund(from as RefundState, to as RefundState)).toBe(to);
    }
  });
  it('keeps UNKNOWN resolvable only to terminal outcomes and rejects all other edges', () => {
    for (const from of REFUND_STATES)
      for (const to of REFUND_STATES)
        if (!legal[from].includes(to))
          expect(() => transitionRefund(from, to)).toThrow('REFUND_STATE_INVALID');
  });
});

describe('quarantine severity', () => {
  it('marks security and money-integrity findings CRITICAL', () => {
    for (const reason of [
      'SIGNATURE_INVALID',
      'CHANGED_BODY',
      'AMOUNT_MISMATCH',
      'CURRENCY_MISMATCH',
      'DUPLICATE_CAPTURE',
    ] as const)
      expect(findingSeverity(reason)).toBe('CRITICAL');
  });
  it('keeps tolerance findings WARN', () => {
    expect(findingSeverity('UNMAPPED_EVENT')).toBe('WARN');
    expect(findingSeverity('UNPARSEABLE')).toBe('WARN');
  });
});
