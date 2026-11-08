import {
  addDays,
  firstEditableDate,
  nextOccurrence,
  occursOn,
  validateFrequency,
} from '../../../src/modules/subscriptions/domain/schedule.js';

describe('subscription calendar', () => {
  it('anchors alternate and every-N schedules across leap days and month ends', () => {
    expect(addDays('2024-02-28', 1)).toBe('2024-02-29');
    expect(occursOn('2024-02-28', '2024-03-01', { type: 'ALTERNATE_DAYS' })).toBe(true);
    expect(nextOccurrence('2024-01-31', '2024-02-01', { type: 'EVERY_N_DAYS', n: 3 })).toBe(
      '2024-02-03',
    );
    expect(
      nextOccurrence('2024-01-31', '2024-02-01', { type: 'EVERY_N_DAYS', n: 3 }, '2024-02-02'),
    ).toBeNull();
  });
  it('accepts only keys defined for each frequency variant', () => {
    for (const rule of [
      { type: 'DAILY' },
      { type: 'ALTERNATE_DAYS' },
      { type: 'EVERY_N_DAYS', n: 3 },
      { type: 'WEEKDAYS', days: [1, 3] },
    ] as const) {
      expect(() =>
        validateFrequency(rule as Parameters<typeof validateFrequency>[0]),
      ).not.toThrow();
      expect(() =>
        validateFrequency({ ...rule, unexpected: 'canary' } as unknown as Parameters<
          typeof validateFrequency
        >[0]),
      ).toThrow('INVALID_FREQUENCY');
    }
    expect(() =>
      validateFrequency({ type: 'DAILY', n: 3 } as Parameters<typeof validateFrequency>[0]),
    ).toThrow('INVALID_FREQUENCY');
  });
  it('locks tomorrow at exactly 21:00 IST', () => {
    expect(firstEditableDate(new Date('2024-02-28T15:29:59Z'), '21:00')).toBe('2024-02-29');
    expect(firstEditableDate(new Date('2024-02-28T15:30:00Z'), '21:00')).toBe('2024-03-01');
  });
  it('validates weekdays and dates', () => {
    expect(() => validateFrequency({ type: 'WEEKDAYS', days: [1, 1] })).toThrow(
      'INVALID_FREQUENCY',
    );
    expect(() => addDays('2023-02-29', 1)).toThrow('INVALID_DATE');
  });
});
