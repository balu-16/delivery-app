import { sql } from 'kysely';
import type { TransactionContext } from '../../../platform/database/database.js';
import { AGENT_DISCLOSURE_VERSION } from '../contracts/agent.js';

/** Call after locking the customer's account inside the action transaction. */
export async function requireAgentPermission(
  userId: string,
  tx: TransactionContext,
): Promise<void> {
  const flag = await sql<{
    enabled: boolean;
  }>`SELECT enabled FROM feature_flags WHERE key='agent_enabled' FOR SHARE`.execute(tx);
  if (flag.rows[0]?.enabled !== true) throw new Error('AGENT_NOT_CONFIGURED');
  const consent =
    await sql`SELECT 1 FROM consents WHERE user_id=${userId}::uuid AND type='ai_assistant' AND version=${AGENT_DISCLOSURE_VERSION} AND revoked_at IS NULL FOR SHARE`.execute(
      tx,
    );
  if (!consent.rows.length) throw new Error('CONSENT_REQUIRED');
}
