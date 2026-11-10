import type { HoursWindow, StoreSchedule } from '../contracts/schedule.js';

function dateParts(date: Date, timezone: string): { key: string; weekday: number; minute: number } {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const get = (type: string): string => {
    const value = parts.find((part) => part.type === type)?.value;
    if (value === undefined) throw new Error('Unable to determine business time');
    return value;
  };
  const key = `${get('year')}-${get('month')}-${get('day')}`;
  const weekday = new Date(`${key}T00:00:00Z`).getUTCDay();
  return { key, weekday, minute: Number(get('hour')) * 60 + Number(get('minute')) };
}

function previousDay(key: string): string {
  const date = new Date(`${key}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

function validWindow(window: HoursWindow): boolean {
  return (
    Number.isInteger(window.startMinute) &&
    Number.isInteger(window.endMinute) &&
    window.startMinute >= 0 &&
    window.startMinute < 1440 &&
    window.endMinute >= 0 &&
    window.endMinute <= 1440 &&
    window.startMinute !== window.endMinute
  );
}

/** Evaluate at the requested fulfillment instant, never the job's current time. */
export function isStoreOpenAt(schedule: StoreSchedule, instant: Date): boolean {
  if (
    !Number.isFinite(instant.getTime()) ||
    !Number.isInteger(schedule.lastOrderBufferMinutes) ||
    schedule.lastOrderBufferMinutes < 0
  ) {
    throw new Error('Invalid store schedule or instant');
  }
  const local = dateParts(instant, schedule.timezone);
  const holiday = schedule.holidays[local.key];
  if (holiday?.closed) return false;
  const yesterday = previousDay(local.key);
  const yesterdayHoliday = schedule.holidays[yesterday];
  const todayWindows = holiday ? holiday.windows : (schedule.weekly[local.weekday] ?? []);
  const yesterdayWindows = yesterdayHoliday
    ? yesterdayHoliday.closed
      ? []
      : yesterdayHoliday.windows
    : (schedule.weekly[(local.weekday + 6) % 7] ?? []);
  const windows = [
    ...todayWindows.map((window) => ({ window, offset: 0 })),
    ...yesterdayWindows.map((window) => ({ window, offset: -1440 })),
  ];
  return windows.some(({ window, offset }) => {
    if (!validWindow(window)) throw new Error('Invalid opening-hours window');
    const start = window.startMinute + offset;
    const end = window.endMinute + offset + (window.endMinute <= window.startMinute ? 1440 : 0);
    // Seconds are included: a request at the buffer boundary is already closed.
    const localMinute =
      local.minute + instant.getUTCSeconds() / 60 + instant.getUTCMilliseconds() / 60000;
    return localMinute >= start && localMinute < end - schedule.lastOrderBufferMinutes;
  });
}
