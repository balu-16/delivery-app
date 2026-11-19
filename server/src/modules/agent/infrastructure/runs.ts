import { sql } from 'kysely';
import { uuidV7 } from '../../../common/ids/ids.js';
import type { Database, Json, TransactionContext } from '../../../platform/database/database.js';
import type { AgentCard } from '../contracts/agent.js';
import { assertAgentCommitAllowed, lockAgentThread, requireAgentPermission } from './security.js';
import { countedTokenWindowStart } from './usage-cutoff.js';
import { PROMPT_VERSION } from './prompts/system.base.v2.js';

interface ExistingRun {
  id: string;
  outcome: string | null;
  error_code: string | null;
  original_text: string;
  assistant_id: string | null;
  assistant_text: string | null;
  cards: AgentCard[] | null;
}
export type BeginRun =
  | { kind: 'started'; runId: string }
  | {
      kind: 'replay';
      outcome: string | null;
      errorCode: string | null;
      messageId: string | null;
      text: string;
      cards: AgentCard[];
    };

const LOCAL_SKILL = 'local.v1';

export interface LocalInput {
  userId: string;
  threadId: string;
  clientMessageId: string;
  text: string;
}

export interface LocalReply {
  text: string;
  cards: AgentCard[];
}

interface SavedLocalReply extends LocalReply {
  runId: string;
  messageId: string;
}

/**
 * Daily usage since the IST day start. Turns count today’s model runs;
 * counted tokens start at the later of the day start and any account cutoff,
 * so a development reset zeroes counted tokens without hiding turns.
 */
async function usageSince(
  tx: TransactionContext,
  userId: string,
): Promise<{ turns: number; tokens: number }> {
  const day = await sql<{
    day_start: string;
  }>`SELECT ((clock_timestamp() AT TIME ZONE 'Asia/Kolkata')::date AT TIME ZONE 'Asia/Kolkata') AS day_start`.execute(
    tx,
  );
  const dayStart = new Date(day.rows[0]?.day_start ?? new Date());
  const cutoff = await sql<{
    token_cutoff_at: string | null;
  }>`SELECT token_cutoff_at FROM agent_usage_cutoffs WHERE user_id=${userId}::uuid`.execute(tx);
  const rawCutoff = cutoff.rows[0]?.token_cutoff_at ?? null;
  const tokenStart = countedTokenWindowStart(dayStart, rawCutoff ? new Date(rawCutoff) : null);
  const usage = await sql<{
    turns: string;
    tokens: string;
  }>`SELECT count(*) FILTER (WHERE skill IS DISTINCT FROM ${LOCAL_SKILL})::text AS turns,COALESCE(sum(input_tokens+output_tokens) FILTER (WHERE created_at >= ${tokenStart.toISOString()}::timestamptz),0)::text AS tokens FROM agent_runs
    WHERE user_id=${userId}::uuid AND created_at >= ${dayStart.toISOString()}::timestamptz`.execute(
    tx,
  );
  return {
    turns: Number(usage.rows[0]?.turns ?? 0),
    tokens: Number(usage.rows[0]?.tokens ?? 0),
  };
}

/** Durable per-message deduplication, with per-customer limits claimed atomically. */
export class AgentRuns {
  constructor(private readonly db: Database) {}

  async begin(input: {
    userId: string;
    threadId: string;
    clientMessageId: string;
    text: string;
    dailyTurns: number;
    dailyTokens: number;
    outputReservation: number;
  }): Promise<BeginRun> {
    return this.db.transaction().execute(async (tx) => {
      const user =
        await sql`SELECT id FROM users WHERE id=${input.userId}::uuid AND status='ACTIVE' FOR UPDATE`.execute(
          tx,
        );
      if (!user.rows.length) throw new Error('ACCOUNT_DISABLED');
      await requireAgentPermission(input.userId, tx);
      const thread = await sql<{
        status: string;
      }>`SELECT status FROM agent_threads WHERE id=${input.threadId}::uuid AND user_id=${input.userId}::uuid FOR UPDATE`.execute(
        tx,
      );
      if (!thread.rows[0]) throw new Error('RESOURCE_NOT_FOUND');
      if (thread.rows[0].status !== 'active') throw new Error('THREAD_ARCHIVED');
      await assertAgentCommitAllowed(tx, input.userId, input.threadId);
      const previous =
        await sql<ExistingRun>`SELECT r.id,r.outcome,r.error_code,m.text AS original_text,a.id AS assistant_id,a.text AS assistant_text,a.cards
        FROM agent_runs r JOIN agent_messages m ON m.thread_id=r.thread_id AND m.client_message_id=r.client_message_id
        LEFT JOIN agent_messages a ON a.id=r.assistant_message_id
        WHERE r.thread_id=${input.threadId}::uuid AND r.user_id=${input.userId}::uuid AND r.client_message_id=${input.clientMessageId}::uuid`.execute(
          tx,
        );
      const existing = previous.rows[0];
      if (existing) {
        if (existing.original_text !== input.text) throw new Error('IDEMPOTENCY_KEY_REUSED');
        if (existing.outcome === 'running') throw new Error('RUN_IN_PROGRESS');
        return {
          kind: 'replay',
          outcome: existing.outcome,
          errorCode: existing.error_code,
          messageId: existing.assistant_id,
          text: existing.assistant_text ?? '',
          cards: existing.cards ?? [],
        };
      }
      // A LangGraph interrupt must be resolved before feeding another message to
      // the same checkpoint. Silently superseding it would leave the graph and
      // the persisted draft disagreeing about the pending action, so an active
      // confirmation still blocks new messages (ADR 0004). Expired drafts are
      // marked and no longer block: their card is disabled and the customer
      // can continue chatting.
      await sql`UPDATE agent_drafts SET status='expired',updated_at=clock_timestamp() WHERE thread_id=${input.threadId}::uuid AND user_id=${input.userId}::uuid AND status='pending' AND expires_at<=clock_timestamp()`.execute(
        tx,
      );
      const pending =
        await sql`SELECT id FROM agent_drafts WHERE thread_id=${input.threadId}::uuid AND user_id=${input.userId}::uuid AND status IN ('pending','approved') LIMIT 1`.execute(
          tx,
        );
      if (pending.rows.length) throw new Error('DRAFT_PENDING');
      const usage = await usageSince(tx, input.userId);
      const inputReservation = input.text.length;
      if (
        usage.turns >= input.dailyTurns ||
        usage.tokens + inputReservation + input.outputReservation > input.dailyTokens
      )
        throw new Error('AGENT_DAILY_LIMIT');
      const runId = uuidV7(),
        messageId = uuidV7();
      // Background admission may already have persisted this exact user message.
      const message = await sql<{
        text: string;
        role: string;
      }>`INSERT INTO agent_messages(id,thread_id,role,text,client_message_id)
        VALUES(${messageId}::uuid,${input.threadId}::uuid,'user',${input.text},${input.clientMessageId}::uuid)
        ON CONFLICT(thread_id,client_message_id) DO UPDATE SET client_message_id=EXCLUDED.client_message_id
        RETURNING text,role`.execute(tx);
      if (message.rows[0]?.text !== input.text || message.rows[0]?.role !== 'user')
        throw new Error('IDEMPOTENCY_KEY_REUSED');
      await sql`INSERT INTO agent_runs(id,thread_id,user_id,client_message_id,skill,input_tokens,output_tokens,outcome) VALUES(${runId}::uuid,${input.threadId}::uuid,${input.userId}::uuid,${input.clientMessageId}::uuid,${PROMPT_VERSION},${inputReservation},${input.outputReservation},'running')`.execute(
        tx,
      );
      await sql`UPDATE agent_threads SET last_message_at=clock_timestamp() WHERE id=${input.threadId}::uuid`.execute(
        tx,
      );
      return { kind: 'started', runId };
    });
  }

  /** Look up local retries before interpreting a reply against the current choice. */
  replayLocal(input: LocalInput): Promise<SavedLocalReply | null> {
    return this.findLocalReply(this.db, input);
  }

  private async findLocalReply(
    db: Database | TransactionContext,
    input: LocalInput,
  ): Promise<SavedLocalReply | null> {
    const previous = await sql<{
      runId: string;
      messageId: string;
      original: string;
      text: string;
      cards: AgentCard[];
    }>`SELECT r.id AS "runId",a.id AS "messageId",m.text AS original,a.text,a.cards
      FROM agent_runs r JOIN agent_messages m ON m.thread_id=r.thread_id AND m.client_message_id=r.client_message_id
      JOIN agent_messages a ON a.id=r.assistant_message_id
      WHERE r.thread_id=${input.threadId}::uuid AND r.user_id=${input.userId}::uuid
        AND r.client_message_id=${input.clientMessageId}::uuid AND r.skill=${LOCAL_SKILL}`.execute(
      db,
    );
    const row = previous.rows[0];
    if (!row) return null;
    if (row.original !== input.text) throw new Error('IDEMPOTENCY_KEY_REUSED');
    return { runId: row.runId, messageId: row.messageId, text: row.text, cards: row.cards };
  }

  /** A local answer and any confirmed cart change are saved together. */
  async completeLocal(
    input: LocalInput,
    reply: (tx: TransactionContext) => Promise<LocalReply>,
    outer?: TransactionContext,
  ): Promise<SavedLocalReply> {
    const started = Date.now();
    const save = async (tx: TransactionContext) => {
      if (!outer) await lockAgentThread(tx, input.userId, input.threadId);
      const previous = await this.findLocalReply(tx, input);
      if (previous) return previous;
      // Claim the message before handling a choice. The same id may already belong
      // to a model turn, even if its text also matches a newly created choice.
      const inserted =
        await sql`INSERT INTO agent_messages(id,thread_id,role,text,client_message_id)
        VALUES(${uuidV7()}::uuid,${input.threadId}::uuid,'user',${input.text},${input.clientMessageId}::uuid)
        ON CONFLICT(thread_id,client_message_id) DO NOTHING RETURNING id`.execute(tx);
      if (!inserted.rows.length) throw new Error('IDEMPOTENCY_KEY_REUSED');
      const body = await reply(tx);
      const runId = uuidV7(),
        messageId = uuidV7();
      await sql`INSERT INTO agent_messages(id,thread_id,role,text,cards) VALUES(${messageId}::uuid,
        ${input.threadId}::uuid,'assistant',${body.text},${JSON.stringify(body.cards)}::jsonb)`.execute(
        tx,
      );
      await sql`INSERT INTO agent_runs(id,thread_id,user_id,client_message_id,assistant_message_id,
        skill,outcome,latency_ms) VALUES(${runId}::uuid,${input.threadId}::uuid,${input.userId}::uuid,
        ${input.clientMessageId}::uuid,${messageId}::uuid,${LOCAL_SKILL},'completed',${Date.now() - started})`.execute(
        tx,
      );
      await sql`UPDATE agent_threads SET last_message_at=clock_timestamp() WHERE id=${input.threadId}::uuid`.execute(
        tx,
      );
      return { ...body, messageId, runId };
    };
    return outer ? save(outer) : this.db.transaction().execute(save);
  }

  async beginResume(input: {
    userId: string;
    threadId: string;
    draftId: string;
    decision: 'approve' | 'reject';
    dailyTurns: number;
    dailyTokens: number;
    outputReservation: number;
  }): Promise<
    { kind: 'started'; runId: string } | { kind: 'resolved'; status: string; result: Json | null }
  > {
    return this.db.transaction().execute(async (tx) => {
      const user =
        await sql`SELECT id FROM users WHERE id=${input.userId}::uuid AND status='ACTIVE' FOR UPDATE`.execute(
          tx,
        );
      if (!user.rows.length) throw new Error('ACCOUNT_DISABLED');
      await requireAgentPermission(input.userId, tx);
      const thread = await sql<{
        status: string;
      }>`SELECT status FROM agent_threads WHERE id=${input.threadId}::uuid AND user_id=${input.userId}::uuid FOR UPDATE`.execute(
        tx,
      );
      if (!thread.rows[0]) throw new Error('RESOURCE_NOT_FOUND');
      if (thread.rows[0].status !== 'active') throw new Error('THREAD_ARCHIVED');
      await assertAgentCommitAllowed(tx, input.userId, input.threadId);
      const found = await sql<{
        status: string;
        result: Json | null;
      }>`SELECT status,result FROM agent_drafts WHERE id=${input.draftId}::uuid AND thread_id=${input.threadId}::uuid AND user_id=${input.userId}::uuid FOR UPDATE`.execute(
        tx,
      );
      const draft = found.rows[0];
      if (!draft) throw new Error('RESOURCE_NOT_FOUND');
      if (
        draft.status !== 'pending' &&
        !(draft.status === 'approved' && input.decision === 'approve')
      ) {
        if (
          (draft.status === 'executed' && input.decision !== 'approve') ||
          (draft.status === 'rejected' && input.decision !== 'reject')
        )
          throw new Error('DRAFT_NOT_PENDING');
        return { kind: 'resolved', status: draft.status, result: draft.result };
      }
      const usage = await usageSince(tx, input.userId);
      if (
        usage.turns >= input.dailyTurns ||
        usage.tokens + input.outputReservation > input.dailyTokens
      )
        throw new Error('AGENT_DAILY_LIMIT');
      const runId = uuidV7();
      await sql`INSERT INTO agent_runs(id,thread_id,user_id,skill,input_tokens,output_tokens,outcome) VALUES(${runId}::uuid,${input.threadId}::uuid,${input.userId}::uuid,${PROMPT_VERSION},0,${input.outputReservation},'running')`.execute(
        tx,
      );
      return { kind: 'started', runId };
    });
  }

  async finish(input: {
    runId: string;
    userId: string;
    threadId: string;
    text: string;
    cards: AgentCard[];
    outcome: 'completed' | 'failed' | 'aborted';
    errorCode?: string;
    latencyMs: number;
    timings?: { modelMs?: number; toolMs?: number; dbMs?: number };
    usage?: { inputTokens?: number; outputTokens?: number; thinkingTokens?: number };
    model?: string;
    toolCalls?: number;
  }): Promise<string> {
    return this.db.transaction().execute(async (tx) => {
      // Match the account → thread → job → run lock order used by Stop.
      await sql`SELECT id FROM users WHERE id=${input.userId}::uuid FOR UPDATE`.execute(tx);
      await sql`SELECT id FROM agent_threads WHERE id=${input.threadId}::uuid AND user_id=${input.userId}::uuid FOR UPDATE`.execute(
        tx,
      );
      if (input.outcome === 'completed')
        await assertAgentCommitAllowed(tx, input.userId, input.threadId);
      const found = await sql<{
        outcome: string;
        assistant_message_id: string | null;
      }>`SELECT outcome,assistant_message_id FROM agent_runs WHERE id=${input.runId}::uuid AND user_id=${input.userId}::uuid AND thread_id=${input.threadId}::uuid FOR UPDATE`.execute(
        tx,
      );
      const run = found.rows[0];
      if (!run) throw new Error('RESOURCE_NOT_FOUND');
      if (run.assistant_message_id) return run.assistant_message_id;
      if (run.outcome !== 'running') throw new Error('RUN_IN_PROGRESS');
      const id = uuidV7();
      await sql`INSERT INTO agent_messages(id,thread_id,role,text,cards) VALUES(${id}::uuid,${input.threadId}::uuid,'assistant',${input.text},${JSON.stringify(input.cards as unknown as Json)}::jsonb)`.execute(
        tx,
      );
      // Reported usage replaces the opening reservations; a failed run keeps them.
      await sql`UPDATE agent_runs SET outcome=${input.outcome},error_code=${input.errorCode ?? null},assistant_message_id=${id}::uuid,latency_ms=${Math.max(0, Math.round(input.latencyMs))},
        model_ms=${input.timings?.modelMs === undefined ? null : Math.max(0, Math.round(input.timings.modelMs))},
        tool_ms=${input.timings?.toolMs === undefined ? null : Math.max(0, Math.round(input.timings.toolMs))},
        db_ms=${input.timings?.dbMs === undefined ? null : Math.max(0, Math.round(input.timings.dbMs))},
        input_tokens=COALESCE(${input.usage?.inputTokens ?? null},input_tokens),
        output_tokens=COALESCE(${input.usage?.outputTokens ?? null},output_tokens),
        thinking_tokens=COALESCE(${input.usage?.thinkingTokens ?? null},thinking_tokens),
        model=COALESCE(${input.model ?? null},model),
        tool_calls=COALESCE(${input.toolCalls ?? null},tool_calls) WHERE id=${input.runId}::uuid`.execute(
        tx,
      );
      await sql`UPDATE agent_threads SET last_message_at=clock_timestamp() WHERE id=${input.threadId}::uuid`.execute(
        tx,
      );
      return id;
    });
  }

  /** Stores only the duration of the finish transaction, not all database time. */
  async recordDbMs(runId: string, dbMs: number): Promise<void> {
    await sql`UPDATE agent_runs SET db_ms=${Math.max(0, Math.round(dbMs))} WHERE id=${runId}::uuid`.execute(
      this.db,
    );
  }
}
