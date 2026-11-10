import { computeEarnings, earningsDefaults } from '../../../src/modules/riders/domain/earnings.js';
import type { EarningTaskInput } from '../../../src/modules/riders/contracts/riders.js';

function input(overrides: Partial<EarningTaskInput> = {}): EarningTaskInput {
  return {
    taskId: '018f0000-0000-7000-8000-000000000001',
    orderId: '018f0000-0000-7000-8000-000000000002',
    riderId: '018f0000-0000-7000-8000-000000000003',
    distanceMetres: 2500,
    detentionMinutes: 0,
    tipPaise: '0',
    ...overrides,
  };
}

describe('rider earnings (23.6, exactly-once math)', () => {
  test('base + distance + detention + tip reconcile to the paisa', () => {
    const config = earningsDefaults();
    const result = computeEarnings(input({ tipPaise: '2000', detentionMinutes: 10 }), config);
    // base 3000 + 3 km × 800 + 5 billable minutes × 100 + tip 2000
    expect(result.basePaise).toBe('3000');
    expect(result.distancePaise).toBe('2400');
    expect(result.detentionPaise).toBe('500');
    expect(result.incentivePaise).toBe('0');
    expect(result.tipPaise).toBe('2000');
    expect(result.totalPaise).toBe('7900');
  });

  test('distance rounds half-up to whole kilometres', () => {
    const config = earningsDefaults();
    expect(computeEarnings(input({ distanceMetres: 499 }), config).distancePaise).toBe('0');
    expect(computeEarnings(input({ distanceMetres: 500 }), config).distancePaise).toBe('800');
    expect(computeEarnings(input({ distanceMetres: 1499 }), config).distancePaise).toBe('800');
    expect(computeEarnings(input({ distanceMetres: 1500 }), config).distancePaise).toBe('1600');
  });

  test('the free detention window is not paid', () => {
    const config = earningsDefaults();
    expect(computeEarnings(input({ detentionMinutes: 5 }), config).detentionPaise).toBe('0');
    expect(computeEarnings(input({ detentionMinutes: 6 }), config).detentionPaise).toBe('100');
    expect(computeEarnings(input({ detentionMinutes: 0 }), config).detentionMinutes).toBe(0);
  });

  test('computation is pure: identical inputs produce identical money', () => {
    const config = earningsDefaults();
    const one = computeEarnings(input({ distanceMetres: 3200, tipPaise: '1500' }), config);
    const two = computeEarnings(input({ distanceMetres: 3200, tipPaise: '1500' }), config);
    expect(one).toEqual(two);
  });

  test('negative or malformed tips never enter the computation', () => {
    const config = earningsDefaults();
    expect(() => computeEarnings(input({ tipPaise: '-1' }), config)).toThrow();
    expect(() => computeEarnings(input({ tipPaise: '1.5' }), config)).toThrow('INVALID_MONEY');
  });

  test('zero distance still pays the base', () => {
    const config = earningsDefaults();
    const result = computeEarnings(input({ distanceMetres: 0 }), config);
    expect(result.totalPaise).toBe('3000');
  });
});
