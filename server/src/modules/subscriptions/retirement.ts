/**
 * Subscription retirement guard (plan3 section 7, compatibility phase).
 *
 * Recurring dairy subscriptions are retired throughout the platform. The
 * compat controllers remain registered for mixed-version mobile clients:
 * reads return empty/disabled shapes and schedule-changing writes return
 * `410 SUBSCRIPTIONS_RETIRED`. Generation, recovery and forecast enqueue
 * and execution are fenced here, including the transactional order-creation
 * point, so leftover jobs drain with a deterministic retired outcome.
 *
 * Keep this guard available while restoring navigation for rollback; only
 * remove it after older clients and worker versions have moved off the
 * retired routes and the queue is quiescent. Historical orders, balances,
 * invoices, refunds and compliance records are preserved.
 */
export const SUBSCRIPTIONS_RETIRED = 'SUBSCRIPTIONS_RETIRED';

/** Deterministic outcome recorded for leftover generation work. */
export const RETIRED_OCCURRENCE_REASON = 'SUBSCRIPTIONS_RETIRED';

/** Audit evidence recorded when leftover work is retired. */
export const RETIRED_AUDIT_ACTION = 'SUBSCRIPTIONS_RETIRED';

export function subscriptionsRetired(): boolean {
  return true;
}

export function throwRetired(): never {
  throw new Error(SUBSCRIPTIONS_RETIRED);
}
