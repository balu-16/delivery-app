/**
 * Promotional quiet hours in IST. India has no DST, so the +05:30 offset is
 * fixed; all math is pure and injectable-clock testable.
 */
export const IST_OFFSET_MINUTES = 330;

export interface QuietWindow {
  /** Inclusive start minute-of-day in IST, 0..1439. */
  startMinute: number;
  /** Exclusive end minute-of-day in IST, 0..1439; may wrap past midnight. */
  endMinute: number;
}

export function istMinuteOfDay(at: Date): number {
  if (Number.isNaN(at.getTime())) throw new Error('INVALID_INSTANT');
  const shifted = new Date(at.getTime() + IST_OFFSET_MINUTES * 60_000);
  return shifted.getUTCHours() * 60 + shifted.getUTCMinutes();
}

/**
 * True when the instant falls inside [start, end) IST; a wrapped window
 * (start > end, e.g. 21:00→08:00) spans midnight. Exact boundary semantics:
 * the start minute is held, the end minute is released.
 */
export function isInQuietHours(at: Date, window: QuietWindow): boolean {
  if (
    !Number.isInteger(window.startMinute) ||
    window.startMinute < 0 ||
    window.startMinute > 1439 ||
    !Number.isInteger(window.endMinute) ||
    window.endMinute < 0 ||
    window.endMinute > 1439
  )
    throw new Error('INVALID_QUIET_WINDOW');
  const minute = istMinuteOfDay(at);
  if (window.startMinute === window.endMinute) return false; // empty window
  if (window.startMinute < window.endMinute)
    return minute >= window.startMinute && minute < window.endMinute;
  return minute >= window.startMinute || minute < window.endMinute;
}

/** Next instant the window releases, for QUIET_HELD retry scheduling. */
export function quietHoursEnd(at: Date, window: QuietWindow): Date {
  const shifted = new Date(at.getTime() + IST_OFFSET_MINUTES * 60_000);
  const midnight = Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate());
  let endUtcMs: number;
  if (window.startMinute === window.endMinute) endUtcMs = shifted.getTime();
  else if (window.startMinute < window.endMinute) {
    endUtcMs =
      midnight + window.endMinute * 60_000 <= shifted.getTime()
        ? midnight + 86_400_000 + window.endMinute * 60_000
        : midnight + window.endMinute * 60_000;
  } else {
    endUtcMs =
      minuteOfDay(shifted) < window.endMinute
        ? midnight + window.endMinute * 60_000
        : midnight + 86_400_000 + window.endMinute * 60_000;
  }
  return new Date(endUtcMs - IST_OFFSET_MINUTES * 60_000);
}

function minuteOfDay(shifted: Date): number {
  return shifted.getUTCHours() * 60 + shifted.getUTCMinutes();
}
