import {
  isInQuietHours,
  istMinuteOfDay,
  quietHoursEnd,
  type QuietWindow,
} from '../../../src/modules/notifications/domain/quiet-hours.js';

const NIGHT: QuietWindow = { startMinute: 21 * 60, endMinute: 8 * 60 };

function utc(iso: string): Date {
  return new Date(iso);
}

describe('promotional quiet hours (IST)', () => {
  it('computes minute-of-day at the fixed +05:30 offset', () => {
    expect(istMinuteOfDay(utc('2026-11-07T15:30:00Z'))).toBe(21 * 60); // 21:00 IST
    expect(istMinuteOfDay(utc('2026-11-07T02:30:00Z'))).toBe(8 * 60); // 08:00 IST
    expect(istMinuteOfDay(utc('2026-11-07T00:00:00Z'))).toBe(5 * 60 + 30);
  });

  it('holds the exact start minute and releases the exact end minute', () => {
    expect(isInQuietHours(utc('2026-11-07T15:29:59Z'), NIGHT)).toBe(false); // 20:59:59 IST
    expect(isInQuietHours(utc('2026-11-07T15:30:00Z'), NIGHT)).toBe(true); // 21:00:00 IST
    expect(isInQuietHours(utc('2026-11-08T02:29:59Z'), NIGHT)).toBe(true); // 07:59:59 IST
    expect(isInQuietHours(utc('2026-11-08T02:30:00Z'), NIGHT)).toBe(false); // 08:00:00 IST
  });

  it('holds across the IST midnight wrap', () => {
    expect(isInQuietHours(utc('2026-11-07T18:59:00Z'), NIGHT)).toBe(true); // 00:29 IST
    expect(isInQuietHours(utc('2026-11-07T12:00:00Z'), NIGHT)).toBe(false); // 17:30 IST
  });

  it('treats an equal start and end as an empty window', () => {
    const empty: QuietWindow = { startMinute: 21 * 60, endMinute: 21 * 60 };
    expect(isInQuietHours(utc('2026-11-07T15:30:00Z'), empty)).toBe(false);
  });

  it('rejects invalid windows and instants', () => {
    expect(() =>
      isInQuietHours(utc('2026-11-07T15:30:00Z'), { startMinute: -1, endMinute: 0 }),
    ).toThrow('INVALID_QUIET_WINDOW');
    expect(() =>
      isInQuietHours(utc('2026-11-07T15:30:00Z'), { startMinute: 0, endMinute: 1440 }),
    ).toThrow('INVALID_QUIET_WINDOW');
    expect(() => isInQuietHours(new Date('not-a-date'), NIGHT)).toThrow('INVALID_INSTANT');
  });

  it('schedules release at the next window end', () => {
    // Held at 21:00 IST Nov 7 → released 08:00 IST Nov 8.
    expect(quietHoursEnd(utc('2026-11-07T15:30:00Z'), NIGHT).toISOString()).toBe(
      '2026-11-08T02:30:00.000Z',
    );
    // Held at 01:00 IST Nov 8 → released 08:00 IST the same IST day.
    expect(quietHoursEnd(utc('2026-11-07T19:30:00Z'), NIGHT).toISOString()).toBe(
      '2026-11-08T02:30:00.000Z',
    );
    // Held at 23:59 IST Nov 7 → released 08:00 IST Nov 8.
    expect(quietHoursEnd(utc('2026-11-07T18:29:00Z'), NIGHT).toISOString()).toBe(
      '2026-11-08T02:30:00.000Z',
    );
  });

  it('release instant is outside the window (no indefinite hold)', () => {
    const held = utc('2026-11-07T16:45:00Z'); // 22:15 IST
    const release = quietHoursEnd(held, NIGHT);
    expect(isInQuietHours(release, NIGHT)).toBe(false);
  });
});
