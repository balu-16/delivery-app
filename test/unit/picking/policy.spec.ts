import {
  assertOperationReference,
  assertPickedQuantity,
  assertScanMatch,
  assertShortReason,
  canComplete,
  pickQuantity,
  shortQuantity,
  transitionItem,
  transitionTask,
} from '../../../src/modules/picking/domain/policy.js';
import { assertSubstitutionAllowed } from '../../../src/modules/picking/domain/substitution.js';
import { isBreached, slaDueAt } from '../../../src/modules/picking/domain/sla.js';

test('pick quantities are whole saleable units in bigint bounds', () => {
  expect(pickQuantity('10')).toBe(10n);
  expect(pickQuantity('0', true)).toBe(0n);
  for (const bad of ['1.5', '-1', '0', '', '9223372036854775808'])
    expect(() => pickQuantity(bad)).toThrow('INVALID_QUANTITY');
});

test('task state machine permits exactly the documented transitions', () => {
  expect(transitionTask('PENDING', 'ASSIGNED')).toBe('ASSIGNED');
  expect(transitionTask('ASSIGNED', 'IN_PROGRESS')).toBe('IN_PROGRESS');
  expect(transitionTask('ASSIGNED', 'PENDING')).toBe('PENDING');
  expect(transitionTask('IN_PROGRESS', 'COMPLETED')).toBe('COMPLETED');
  expect(() => transitionTask('PENDING', 'IN_PROGRESS')).toThrow('INVALID_STATE_TRANSITION');
  expect(() => transitionTask('COMPLETED', 'CANCELLED')).toThrow('INVALID_STATE_TRANSITION');
  expect(() => transitionTask('CANCELLED', 'PENDING')).toThrow('INVALID_STATE_TRANSITION');
});

test('item transitions resolve forward only before completion', () => {
  expect(transitionItem('PENDING', 'PICKED')).toBe('PICKED');
  expect(transitionItem('PENDING', 'SHORT')).toBe('SHORT');
  expect(transitionItem('PICKED', 'SHORT')).toBe('SHORT');
  expect(transitionItem('SHORT', 'SHORT')).toBe('SHORT');
  expect(() => transitionItem('SHORT', 'PENDING')).toThrow('INVALID_STATE_TRANSITION');
  expect(() => transitionItem('SUBSTITUTED', 'PENDING')).toThrow('INVALID_STATE_TRANSITION');
  expect(() => transitionItem('PENDING' as never, 'PENDING')).toThrow('INVALID_STATE_TRANSITION');
});

test('scan matching is trimmed, case-insensitive and fails closed', () => {
  assertScanMatch('ABC-123 ', ' abc-123');
  expect(() => assertScanMatch('ABC-123', 'abc-124')).toThrow('WRONG_ITEM');
  expect(() => assertScanMatch(null, 'ABC-123')).toThrow('WRONG_ITEM');
  expect(() => assertScanMatch('ABC-123', '')).toThrow('WRONG_ITEM');
  expect(() => assertScanMatch('ABC-123', 'X'.repeat(101))).toThrow('WRONG_ITEM');
});

test('picked quantity can never exceed the expected quantity', () => {
  assertPickedQuantity(10n, 10n);
  expect(() => assertPickedQuantity(10n, 11n)).toThrow('INVALID_QUANTITY');
  expect(() => assertPickedQuantity(10n, 0n)).toThrow('INVALID_QUANTITY');
});

test('shorts resolve only the outstanding remainder', () => {
  expect(shortQuantity(10n, 4n)).toBe(6n);
  expect(() => shortQuantity(10n, 10n)).toThrow('ITEM_ALREADY_RESOLVED');
  expect(() => shortQuantity(10n, 12n)).toThrow('ITEM_ALREADY_RESOLVED');
});

test('short reasons are exactly the configured enum', () => {
  for (const reason of ['OUT_OF_STOCK', 'DAMAGED', 'EXPIRED', 'NOT_FOUND'])
    assertShortReason(reason);
  expect(() => assertShortReason('OTHER')).toThrow('INVALID_SHORT_REASON');
});

test('completion requires every item resolved', () => {
  expect(canComplete([{ status: 'PICKED' }, { status: 'SHORT' }, { status: 'SUBSTITUTED' }])).toBe(
    true,
  );
  expect(canComplete([{ status: 'PICKED' }, { status: 'PENDING' }])).toBe(false);
  expect(canComplete([])).toBe(false);
});

test('substitution requires the flag, a listed candidate and sane input', () => {
  const candidates = [{ variantId: 'v1', candidateVariantId: 'v2' }];
  assertSubstitutionAllowed(true, 'v1', 'v2', candidates);
  expect(() => assertSubstitutionAllowed(false, 'v1', 'v2', candidates)).toThrow(
    'SUBSTITUTION_DISABLED',
  );
  expect(() => assertSubstitutionAllowed(true, 'v1', 'v3', candidates)).toThrow(
    'SUBSTITUTION_NOT_PERMITTED',
  );
  expect(() => assertSubstitutionAllowed(true, 'v1', 'v1', candidates)).toThrow(
    'SUBSTITUTION_NOT_PERMITTED',
  );
});

test('SLA due dates are wall-clock minutes and breaches are strict', () => {
  const base = new Date('2026-11-07T06:00:00Z');
  expect(slaDueAt(base, 30).toISOString()).toBe('2026-11-07T06:30:00.000Z');
  expect(() => slaDueAt(base, 0)).toThrow('INVALID_SLA_MINUTES');
  expect(() => slaDueAt(base, 1441)).toThrow('INVALID_SLA_MINUTES');
  expect(isBreached(new Date('2026-11-07T06:30:00Z'), new Date('2026-11-07T06:30:01Z'))).toBe(true);
  expect(isBreached(new Date('2026-11-07T06:30:00Z'), new Date('2026-11-07T06:30:00Z'))).toBe(
    false,
  );
});

test('operation references are bounded', () => {
  assertOperationReference('abc');
  expect(() => assertOperationReference('')).toThrow('INVALID_INPUT');
  expect(() => assertOperationReference('x'.repeat(151))).toThrow('INVALID_INPUT');
});
