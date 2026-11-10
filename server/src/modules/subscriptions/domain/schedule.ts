/** Subscription dates are ISO calendar dates in Asia/Kolkata, never instants. */
import type { FrequencyRule } from '../contracts/subscriptions.js';
export type { FrequencyRule } from '../contracts/subscriptions.js';

const DAY_MS = 86_400_000;
function dayNumber(date: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('INVALID_DATE');
  const parsed = Date.parse(`${date}T00:00:00Z`);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString().slice(0, 10) !== date)
    throw new Error('INVALID_DATE');
  return parsed / DAY_MS;
}
export function addDays(date: string, days: number): string {
  if (!Number.isSafeInteger(days)) throw new Error('INVALID_DATE');
  return new Date((dayNumber(date) + days) * DAY_MS).toISOString().slice(0, 10);
}
export function validateFrequency(rule: FrequencyRule): void {
  if (!rule || typeof rule !== 'object') throw new Error('INVALID_FREQUENCY');
  const allowed =
    rule.type === 'EVERY_N_DAYS'
      ? ['type', 'n']
      : rule.type === 'WEEKDAYS'
        ? ['type', 'days']
        : ['type'];
  if (Object.keys(rule).some((key) => !allowed.includes(key))) throw new Error('INVALID_FREQUENCY');
  switch (rule.type) {
    case 'DAILY':
    case 'ALTERNATE_DAYS':
      return;
    case 'EVERY_N_DAYS':
      if (Number.isSafeInteger(rule.n) && rule.n >= 1 && rule.n <= 365) return;
      break;
    case 'WEEKDAYS':
      if (
        Array.isArray(rule.days) &&
        rule.days.length > 0 &&
        rule.days.length <= 7 &&
        new Set(rule.days).size === rule.days.length &&
        rule.days.every((d) => Number.isInteger(d) && d >= 0 && d <= 6)
      )
        return;
  }
  throw new Error('INVALID_FREQUENCY');
}
/** Weekday numbers follow JavaScript: Sunday 0 through Saturday 6. */
export function occursOn(startDate: string, date: string, rule: FrequencyRule): boolean {
  validateFrequency(rule);
  const start = dayNumber(startDate),
    current = dayNumber(date);
  const offset = current - start;
  if (offset < 0) return false;
  switch (rule.type) {
    case 'DAILY':
      return true;
    case 'ALTERNATE_DAYS':
      return offset % 2 === 0;
    case 'EVERY_N_DAYS':
      return offset % rule.n === 0;
    case 'WEEKDAYS':
      return rule.days.includes(new Date(current * DAY_MS).getUTCDay());
  }
}
export function nextOccurrence(
  startDate: string,
  from: string,
  rule: FrequencyRule,
  endDate?: string | null,
): string | null {
  validateFrequency(rule);
  let current = dayNumber(from) < dayNumber(startDate) ? startDate : from;
  if (endDate) dayNumber(endDate);
  // Every supported rule recurs within 365 days.
  for (let i = 0; i <= 365; i++, current = addDays(current, 1)) {
    if (endDate && current > endDate) return null;
    if (occursOn(startDate, current, rule)) return current;
  }
  return null;
}
/** Exact boundary: before D−1 cutoff D is editable; at/after it is locked. */
export function firstEditableDate(now: Date, cutoff: string): string {
  if (!Number.isFinite(now.getTime()) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(cutoff))
    throw new Error('INVALID_CUTOFF');
  const ist = new Date(now.getTime() + 330 * 60_000);
  const date = ist.toISOString().slice(0, 10);
  const current = ist.toISOString().slice(11, 16);
  return addDays(date, current < cutoff ? 1 : 2);
}
