import { sql } from 'kysely';
import { uuidV7 } from '../../../common/ids/ids.js';
import {
  databaseTimeAfterLock,
  type Database,
  type Json,
  type TransactionContext,
} from '../../../platform/database/database.js';
import { assertPendingDraft, draftHash } from './guards.js';
import { requireAgentPermission } from './security.js';

export interface DraftRecord {
  id: string;
  thread_id: string;
  user_id: string;
  type: string;
  tool_call_id: string;
  payload: Json;
  payload_hash: string;
  status: string;
  expires_at: Date;
  result: Json | null;
}
export type DraftDecisionResult =
  { status: 'executed'; result: Json } | { status: 'rejected' | 'expired' | 'stale'; result: null };
/** Return this outcome from an executor when authoritative state has changed. */
export const STALE_DRAFT = Symbol('STALE_DRAFT');

/** Approval metadata and transactional side effects live together in PostgreSQL. */
export class AgentDrafts {
  constructor(private readonly db: Database) {}

  async byCall(userId: string, threadId: string, toolCallId: string): Promise<DraftRecord | null> {
    const result =
      await sql<DraftRecord>`SELECT * FROM agent_drafts WHERE user_id=${userId}::uuid AND thread_id=${threadId}::uuid AND tool_call_id=${toolCallId}`.execute(
        this.db,
      );
    return result.rows[0] ?? null;
  }

  /** Stage an external saga only after an owner-approved, intact draft. */
  async stageDecision(input: {
    userId: string;
    threadId: string;
    draftId: string;
    decision: 'approve' | 'reject';
  }): Promise<{ status: string; payload: Json; result: Json | null }> {
    return this.db.transaction().execute(async (tx) => {
      const user =
        await sql`SELECT id FROM users WHERE id=${input.userId}::uuid AND status='ACTIVE' FOR UPDATE`.execute(
          tx,
        );
      if (!user.rows.length) throw new Error('ACCOUNT_DISABLED');
      await requireAgentPermission(input.userId, tx);
      const found =
        await sql<DraftRecord>`SELECT * FROM agent_drafts WHERE id=${input.draftId}::uuid AND user_id=${input.userId}::uuid AND thread_id=${input.threadId}::uuid FOR UPDATE`.execute(
          tx,
        );
      const draft = found.rows[0];
      if (!draft) throw new Error('RESOURCE_NOT_FOUND');
      if (draft.status === 'executed' && input.decision === 'approve')
        return { status: 'executed', payload: draft.payload, result: draft.result };
      if (draft.status === 'rejected' && input.decision === 'reject')
        return { status: 'rejected', payload: draft.payload, result: null };
      if (
        !['pending', 'approved'].includes(draft.status) ||
        (draft.status === 'approved' && input.decision === 'reject')
      )
        throw new Error('DRAFT_NOT_PENDING');
      const now = await databaseTimeAfterLock(tx);
      if (draft.expires_at.getTime() <= now.getTime()) {
        await sql`UPDATE agent_drafts SET status='expired',updated_at=clock_timestamp() WHERE id=${draft.id}::uuid`.execute(
          tx,
        );
        return { status: 'expired', payload: draft.payload, result: null };
      }
      if (draftHash(draft.payload) !== draft.payload_hash) throw new Error('DRAFT_INVALID');
      const status = input.decision === 'approve' ? 'approved' : 'rejected';
      await sql`UPDATE agent_drafts SET status=${status},updated_at=clock_timestamp() WHERE id=${draft.id}::uuid`.execute(
        tx,
      );
      return { status, payload: draft.payload, result: null };
    });
  }

  async prepare(input: {
    userId: string;
    threadId: string;
    toolCallId: string;
    type: string;
    payload: Json;
    expiresAt: Date;
  }): Promise<DraftRecord> {
    if (!input.toolCallId || input.toolCallId.length > 200 || !/^[a-z_]{1,40}$/.test(input.type))
      throw new Error('INVALID_INPUT');
    const hash = draftHash(input.payload),
      id = uuidV7();
    return this.db.transaction().execute(async (tx) => {
      const user =
        await sql`SELECT id FROM users WHERE id=${input.userId}::uuid AND status='ACTIVE' FOR UPDATE`.execute(
          tx,
        );
      if (!user.rows.length) throw new Error('ACCOUNT_DISABLED');
      await requireAgentPermission(input.userId, tx);
      await sql`INSERT INTO agent_drafts(id,thread_id,user_id,type,tool_call_id,payload,payload_hash,status,expires_at,idempotency_key)
        SELECT ${id}::uuid,t.id,t.user_id,${input.type},${input.toolCallId},${JSON.stringify(input.payload)}::jsonb,${hash},'pending',${input.expiresAt.toISOString()}::timestamptz,${`agent:${id}`}
        FROM agent_threads t WHERE t.id=${input.threadId}::uuid AND t.user_id=${input.userId}::uuid AND t.status='active'
        ON CONFLICT(thread_id,tool_call_id) DO NOTHING`.execute(tx);
      const found =
        await sql<DraftRecord>`SELECT * FROM agent_drafts WHERE thread_id=${input.threadId}::uuid AND user_id=${input.userId}::uuid AND tool_call_id=${input.toolCallId}`.execute(
          tx,
        );
      const row = found.rows[0];
      if (!row) throw new Error('RESOURCE_NOT_FOUND');
      if (row.payload_hash !== hash || row.type !== input.type)
        throw new Error('IDEMPOTENCY_KEY_REUSED');
      return row;
    });
  }

  async decide(
    input: { userId: string; threadId: string; draftId: string; decision: 'approve' | 'reject' },
    execute: (
      payload: Json,
      tx: TransactionContext,
      idempotencyKey: string,
    ) => Promise<Json | typeof STALE_DRAFT>,
  ): Promise<DraftDecisionResult> {
    return this.db.transaction().execute(async (tx) => {
      // Identity lock matches the existing account-erasure and commerce order.
      const user =
        await sql`SELECT id FROM users WHERE id=${input.userId}::uuid AND status='ACTIVE' FOR UPDATE`.execute(
          tx,
        );
      if (!user.rows.length) throw new Error('ACCOUNT_DISABLED');
      await requireAgentPermission(input.userId, tx);
      const found =
        await sql<DraftRecord>`SELECT * FROM agent_drafts WHERE id=${input.draftId}::uuid AND thread_id=${input.threadId}::uuid AND user_id=${input.userId}::uuid FOR UPDATE`.execute(
          tx,
        );
      const row = found.rows[0];
      if (!row) throw new Error('RESOURCE_NOT_FOUND');
      if (row.status === 'executed' && input.decision === 'approve')
        return { status: 'executed', result: row.result };
      if (row.status === 'rejected' && input.decision === 'reject')
        return { status: 'rejected', result: null };
      if (row.status !== 'pending') throw new Error('DRAFT_NOT_PENDING');
      const now = await databaseTimeAfterLock(tx);
      if (row.expires_at.getTime() <= now.getTime()) {
        await sql`UPDATE agent_drafts SET status='expired',updated_at=clock_timestamp() WHERE id=${row.id}::uuid`.execute(
          tx,
        );
        return { status: 'expired', result: null };
      }
      assertPendingDraft(row.status, row.expires_at, row.payload_hash, row.payload, now);
      if (input.decision === 'reject') {
        await sql`UPDATE agent_drafts SET status='rejected',updated_at=clock_timestamp() WHERE id=${row.id}::uuid`.execute(
          tx,
        );
        return { status: 'rejected', result: null };
      }
      const result = await execute(row.payload, tx, `agent:${row.id}`);
      if (result === STALE_DRAFT) {
        await sql`UPDATE agent_drafts SET status='stale',updated_at=clock_timestamp() WHERE id=${row.id}::uuid`.execute(
          tx,
        );
        return { status: 'stale', result: null };
      }
      await sql`UPDATE agent_drafts SET status='executed',result=${JSON.stringify(result)}::jsonb,updated_at=clock_timestamp() WHERE id=${row.id}::uuid`.execute(
        tx,
      );
      await sql`INSERT INTO audit_log(id,actor_id,action,subject_type,subject_id,details) VALUES(${uuidV7()}::uuid,${input.userId}::uuid,'AGENT_ACTION','agent_draft',${row.id},${JSON.stringify({ source: 'AGENT', threadId: input.threadId, draftId: row.id, type: row.type })}::jsonb)`.execute(
        tx,
      );
      return { status: 'executed', result };
    });
  }
}
