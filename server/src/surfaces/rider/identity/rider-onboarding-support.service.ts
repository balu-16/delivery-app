import { sql } from 'kysely';
import type { TransactionContext } from '../../../platform/database/database.js';
import type { Support } from '../../../modules/support/contracts/support.js';

export const RIDER_ONBOARDING_SUPPORT = Symbol('RIDER_ONBOARDING_SUPPORT');
export const ONBOARDING_TICKET_CATEGORY = 'ONBOARDING';
const ONBOARDING_STATUSES = ['PENDING', 'REJECTED', 'UNDER_REVIEW'];

async function assertOnboardingStatus(tx: TransactionContext, userId: string): Promise<void> {
  const profile = await sql<{ status: string }>`
    SELECT status FROM rider_profiles WHERE user_id=${userId}::uuid`.execute(tx);
  if (!profile.rows[0] || !ONBOARDING_STATUSES.includes(profile.rows[0].status))
    throw new Error('FORBIDDEN');
}

/**
 * Text-only ONBOARDING tickets for applicants the backend still holds in
 * PENDING, REJECTED, or UNDER_REVIEW. Category and ownership are enforced;
 * creation keeps the shared hourly rate limit.
 */
export class RiderOnboardingSupport {
  constructor(private readonly support: Support) {}
  create(userId: string, body: string, reference?: string): Promise<string> {
    return this.support.create(
      userId,
      { category: ONBOARDING_TICKET_CATEGORY, body, reference },
      { beforeCreate: (tx) => assertOnboardingStatus(tx, userId) },
    );
  }
  list(userId: string, cursor?: string, limit?: number) {
    return this.support.list(userId, false, cursor, limit, ONBOARDING_TICKET_CATEGORY);
  }
  detail(userId: string, ticketId: string, cursor?: string, limit?: number) {
    return this.support.detail(userId, ticketId, false, cursor, limit, ONBOARDING_TICKET_CATEGORY);
  }
  message(userId: string, ticketId: string, body: string, reference?: string): Promise<string> {
    return this.support.message(
      userId,
      ticketId,
      { body, category: ONBOARDING_TICKET_CATEGORY, reference },
      { beforeMessage: (tx) => assertOnboardingStatus(tx, userId) },
    );
  }
}
