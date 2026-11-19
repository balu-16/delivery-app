/**
 * Counted-token window after a development quota reset.
 *
 * Turns are always counted from the start of the IST day. Tokens are counted
 * from the later of the IST day start and the account cutoff, so a cutoff
 * set during the day zeroes the counted tokens while today’s turns and run
 * history stay intact. Because the day start advances at midnight IST, a
 * cutoff set today stops affecting the count at that midnight.
 */
export function countedTokenWindowStart(dayStart: Date, cutoff: Date | null): Date {
  if (!cutoff) return dayStart;
  return cutoff.getTime() > dayStart.getTime() ? cutoff : dayStart;
}
