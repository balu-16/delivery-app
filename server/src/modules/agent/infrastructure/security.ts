import { AsyncLocalStorage } from 'node:async_hooks';
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

interface AgentJobLease {
  jobId: string;
  leaseToken: string;
  userId: string;
  threadId: string;
}

const currentJob = new AsyncLocalStorage<AgentJobLease>();

/** Bind the worker identity to every asynchronous tool call in this execution. */
export function withAgentJobLease<T>(lease: AgentJobLease, execute: () => Promise<T>): Promise<T> {
  return currentJob.run(lease, execute);
}

/** Lock and verify the specific worker's lease in the same transaction as a change.
 * Stop and recovery wait for an already-committing transaction; they cannot undo it. */
export async function assertAgentCommitAllowed(
  tx: TransactionContext,
  userId: string,
  threadId: string,
): Promise<void> {
  const lease = currentJob.getStore();
  if (lease) {
    if (lease.userId !== userId || lease.threadId !== threadId) throw new Error('RUN_ABORTED');
    const owned = await sql`SELECT id FROM agent_jobs
      WHERE id=${lease.jobId}::uuid AND user_id=${userId}::uuid AND thread_id=${threadId}::uuid
        AND state='running' AND lease_token=${lease.leaseToken}::uuid
        AND NOT cancel_requested AND lease_until>clock_timestamp() FOR UPDATE`.execute(tx);
    if (!owned.rows.length) throw new Error('RUN_ABORTED');
    return;
  }
  // Customer card actions run outside the worker; they must not race a job.
  const active = await sql`SELECT id FROM agent_jobs WHERE user_id=${userId}::uuid
    AND thread_id=${threadId}::uuid AND state IN ('queued','running') LIMIT 1`.execute(tx);
  if (active.rows.length) throw new Error('RUN_IN_PROGRESS');
}
