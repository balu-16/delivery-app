import { sql } from 'kysely';
import type { Database, TransactionContext } from '../../../platform/database/database.js';
import type { AgentPrivacy } from '../contracts/privacy.js';

/** Checkpoint tables are optional until the explicit checkpointer setup has run. */
async function deleteCheckpoints(
  tx: TransactionContext,
  threadIds: readonly string[],
): Promise<void> {
  if (!threadIds.length) return;
  const tables = await sql<{
    checkpoints: string | null;
    blobs: string | null;
    writes: string | null;
  }>`SELECT to_regclass('public.checkpoints')::text AS checkpoints,to_regclass('public.checkpoint_blobs')::text AS blobs,to_regclass('public.checkpoint_writes')::text AS writes`.execute(
    tx,
  );
  const result = tables.rows[0];
  if (!result?.checkpoints && !result?.blobs && !result?.writes) return;
  if (!result?.checkpoints || !result.blobs || !result.writes)
    throw new Error('CHECKPOINT_SCHEMA_INCOMPLETE');
  await sql`DELETE FROM public.checkpoint_writes WHERE thread_id IN (${sql.join(threadIds)})`.execute(
    tx,
  );
  await sql`DELETE FROM public.checkpoint_blobs WHERE thread_id IN (${sql.join(threadIds)})`.execute(
    tx,
  );
  await sql`DELETE FROM public.checkpoints WHERE thread_id IN (${sql.join(threadIds)})`.execute(tx);
}

export class PostgresAgentPrivacy implements AgentPrivacy {
  constructor(private readonly db: Database) {}
  async hasActiveRuns(userId: string, tx: TransactionContext): Promise<boolean> {
    const rows = await sql<{
      active: boolean;
    }>`SELECT EXISTS(SELECT 1 FROM agent_runs WHERE user_id=${userId}::uuid AND outcome='running' AND created_at>clock_timestamp()-interval '5 minutes') AS active`.execute(
      tx,
    );
    return rows.rows[0]?.active === true;
  }
  async eraseForUser(userId: string, tx: TransactionContext): Promise<void> {
    const threads = await sql<{
      id: string;
    }>`SELECT id::text FROM agent_threads WHERE user_id=${userId}::uuid FOR UPDATE`.execute(tx);
    await deleteCheckpoints(
      tx,
      threads.rows.map((row) => row.id),
    );
    await sql`DELETE FROM agent_nudge_preferences WHERE user_id=${userId}::uuid`.execute(tx);
    await sql`DELETE FROM agent_threads WHERE user_id=${userId}::uuid`.execute(tx);
    await sql`DELETE FROM address_creation_operations WHERE user_id=${userId}::uuid`.execute(tx);
  }
  async deleteThread(userId: string, threadId: string): Promise<void> {
    await this.db.transaction().execute(async (tx) => {
      const user =
        await sql`SELECT id FROM users WHERE id=${userId}::uuid AND status='ACTIVE' FOR UPDATE`.execute(
          tx,
        );
      if (!user.rows.length) throw new Error('ACCOUNT_DISABLED');
      const thread =
        await sql`SELECT id FROM agent_threads WHERE id=${threadId}::uuid AND user_id=${userId}::uuid FOR UPDATE`.execute(
          tx,
        );
      if (!thread.rows.length) throw new Error('RESOURCE_NOT_FOUND');
      const running =
        await sql`SELECT id FROM agent_runs WHERE thread_id=${threadId}::uuid AND outcome='running' AND created_at>clock_timestamp()-interval '5 minutes' LIMIT 1`.execute(
          tx,
        );
      if (running.rows.length) throw new Error('RUN_IN_PROGRESS');
      await deleteCheckpoints(tx, [threadId]);
      await sql`DELETE FROM agent_threads WHERE id=${threadId}::uuid AND user_id=${userId}::uuid`.execute(
        tx,
      );
    });
  }
  async deleteAllThreads(userId: string): Promise<void> {
    await this.db.transaction().execute(async (tx) => {
      const user =
        await sql`SELECT id FROM users WHERE id=${userId}::uuid AND status='ACTIVE' FOR UPDATE`.execute(
          tx,
        );
      if (!user.rows.length) throw new Error('ACCOUNT_DISABLED');
      if (await this.hasActiveRuns(userId, tx)) throw new Error('RUN_IN_PROGRESS');
      const threads = await sql<{
        id: string;
      }>`SELECT id::text FROM agent_threads WHERE user_id=${userId}::uuid FOR UPDATE`.execute(tx);
      const ids = threads.rows.map((row) => row.id);
      await deleteCheckpoints(tx, ids);
      if (ids.length)
        await sql`DELETE FROM agent_threads WHERE user_id=${userId}::uuid`.execute(tx);
    });
  }
  async purgeExpired(days: number, batch: number): Promise<void> {
    if (!Number.isSafeInteger(days) || days < 1 || !Number.isSafeInteger(batch) || batch < 1)
      throw new Error('INVALID_INPUT');
    await this.db.transaction().execute(async (tx) => {
      const threads = await sql<{
        id: string;
      }>`SELECT id::text FROM agent_threads t WHERE last_message_at < clock_timestamp()-${days}*interval '1 day'
        AND NOT EXISTS(SELECT 1 FROM agent_runs r WHERE r.thread_id=t.id AND r.outcome='running' AND r.created_at>clock_timestamp()-interval '5 minutes')
        ORDER BY last_message_at,id LIMIT ${batch} FOR UPDATE SKIP LOCKED`.execute(tx);
      const ids = threads.rows.map((row) => row.id);
      if (!ids.length) return;
      await deleteCheckpoints(tx, ids);
      await sql`DELETE FROM agent_threads WHERE id IN (${sql.join(ids.map((id) => sql`${id}::uuid`))})`.execute(
        tx,
      );
    });
  }
}
