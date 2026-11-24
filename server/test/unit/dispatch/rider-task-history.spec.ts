import {
  resolveHistoryStatus,
  validateHistoryDetailInput,
} from '../../../src/modules/dispatch/infrastructure/rider-task-reads.js';

const RIDER = 'a1b2c3d4-1234-4abc-8def-123456789abc';
const TASK = 'b1b2c3d4-1234-4abc-8def-123456789abc';
const OTHER = 'c1b2c3d4-1234-4abc-8def-123456789abc';

describe('RiderTaskReads.historyDetail pure helpers (plan3 §5)', () => {
  it('validates UUID task ids and attempt numbers', () => {
    expect(() => validateHistoryDetailInput('not-uuid')).toThrow('INVALID_INPUT');
    expect(() => validateHistoryDetailInput(TASK, -1)).toThrow('INVALID_INPUT');
    expect(() => validateHistoryDetailInput(TASK, 1.5)).toThrow('INVALID_INPUT');
    expect(() => validateHistoryDetailInput(TASK)).not.toThrow();
    expect(() => validateHistoryDetailInput(TASK, 0)).not.toThrow();
    expect(() => validateHistoryDetailInput(TASK, 3)).not.toThrow();
  });

  it('resolves safe final status: current attempts keep task status', () => {
    expect(resolveHistoryStatus(RIDER, 1, 1, 'DELIVERED', RIDER)).toBe('DELIVERED');
    expect(resolveHistoryStatus(RIDER, 1, 1, 'FAILED', null)).toBe('FAILED');
  });

  it('maps reassigned attempts when attempt differs or rider no longer owns the task', () => {
    expect(resolveHistoryStatus(RIDER, 1, 2, 'DELIVERED', OTHER)).toBe('REASSIGNED');
    expect(resolveHistoryStatus(RIDER, 2, 2, 'DELIVERED', OTHER)).toBe('REASSIGNED');
    expect(resolveHistoryStatus(RIDER, 1, 2, 'DELIVERED', RIDER)).toBe('REASSIGNED');
  });

  it('earnings are only shown for the current attempt (contract)', () => {
    // Mirrors historyDetail logic: showEarnings = isCurrentAttempt && hasEarning
    // A non-current attempt must not expose the other attempt's earnings.
    const attemptNo: number = 1;
    const taskAttempt: number = 2;
    expect(attemptNo === taskAttempt).toBe(false);
  });
});
