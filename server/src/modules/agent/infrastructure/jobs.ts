import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { sql } from 'kysely';
import type { Redis } from 'ioredis';
import { uuidV7 } from '../../../common/ids/ids.js';
import type { Database, Json, TransactionContext } from '../../../platform/database/database.js';
import { appendEvent } from '../../../platform/outbox/outbox.js';
import type { AgentEvent, AgentLocale } from '../contracts/agent.js';
import { sanitizeAgentText } from './guards.js';
import { requireAgentPermission, withAgentJobLease } from './security.js';
import { isReplayedConfirmation } from './confirmation-events.js';

type State = 'queued' | 'running' | 'completed' | 'waiting' | 'failed' | 'cancelled';
type Decision = 'approve' | 'reject';
interface Job {
  id: string;
  thread_id: string;
  user_id: string;
  kind: 'message' | 'resume';
  client_message_id: string | null;
  message_id: string | null;
  draft_id: string | null;
  decision: Decision | null;
  locale: AgentLocale;
  state: State;
  error_code: string | null;
  lease_token: string | null;
}
export interface AgentJobView {
  id: string;
  threadId: string;
  state: State;
  errorCode: string | null;
  clientMessageId: string | null;
}
type Emit = (event: AgentEvent) => void;
type Execute = (job: Job, text: string | null, signal: AbortSignal, emit: Emit) => Promise<void>;
type Authorize = (userId: string, threadId: string) => Promise<void>;

function view(job: Job): AgentJobView {
  return {
    id: job.id,
    threadId: job.thread_id,
    state: job.state,
    errorCode: job.error_code,
    clientMessageId: job.client_message_id,
  };
}
function terminal(state: State): boolean {
  return state !== 'queued' && state !== 'running';
}

/** Durable admission, bounded worker claims and owner-scoped event replay. */
export class AgentJobs {
  private timer?: ReturnType<typeof setInterval>;
  private ticking = false;
  private lastMaintenance = 0;
  private readonly active = new Map<string, { abort: AbortController; promise: Promise<void> }>();
  private stopping = false;

  constructor(
    private readonly db: Database,
    private readonly redis: Redis,
    private readonly heartbeatKey: string,
    private readonly execute: Execute,
    private readonly authorize: Authorize,
  ) {}

  async start(): Promise<void> {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, 2000);
    this.timer.unref();
    await this.tick();
  }
  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    for (const worker of this.active.values()) worker.abort.abort();
    await Promise.allSettled([...this.active.values()].map((worker) => worker.promise));
  }

  private async lockThread(
    tx: TransactionContext,
    userId: string,
    threadId: string,
    checkPermission = true,
  ): Promise<void> {
    const user =
      await sql`SELECT id FROM users WHERE id=${userId}::uuid AND status='ACTIVE' FOR UPDATE`.execute(
        tx,
      );
    if (!user.rows.length) throw new Error('ACCOUNT_DISABLED');
    if (checkPermission) await requireAgentPermission(userId, tx);
    const thread = await sql<{
      status: string;
    }>`SELECT status FROM agent_threads WHERE id=${threadId}::uuid AND user_id=${userId}::uuid FOR UPDATE`.execute(
      tx,
    );
    if (!thread.rows[0]) throw new Error('RESOURCE_NOT_FOUND');
    if (thread.rows[0].status !== 'active') throw new Error('THREAD_ARCHIVED');
  }

  async submitMessage(input: {
    userId: string;
    threadId: string;
    clientMessageId: string;
    text: string;
    locale: AgentLocale;
  }): Promise<AgentJobView> {
    const workerOnline = await this.redis.exists(this.heartbeatKey);
    const text = sanitizeAgentText(input.text);
    if (!text || text.length > 2000 || text !== input.text.trim()) throw new Error('INVALID_INPUT');
    const job = await this.db.transaction().execute(async (tx) => {
      await this.lockThread(tx, input.userId, input.threadId);
      const key = `message:${input.clientMessageId}`;
      const previous = await sql<
        Job & { text: string }
      >`SELECT j.*,m.text FROM agent_jobs j JOIN agent_messages m ON m.id=j.message_id
        WHERE j.thread_id=${input.threadId}::uuid AND j.user_id=${input.userId}::uuid AND j.request_key=${key}`.execute(
        tx,
      );
      if (previous.rows[0]) {
        if (previous.rows[0].text !== text) throw new Error('IDEMPOTENCY_KEY_REUSED');
        return previous.rows[0];
      }
      if (!workerOnline) throw new Error('AGENT_WORKER_UNAVAILABLE');
      const active =
        await sql`SELECT id FROM agent_jobs WHERE thread_id=${input.threadId}::uuid AND state IN ('queued','running') LIMIT 1`.execute(
          tx,
        );
      if (active.rows.length) throw new Error('RUN_IN_PROGRESS');
      await sql`UPDATE agent_drafts SET status='expired',updated_at=clock_timestamp() WHERE thread_id=${input.threadId}::uuid AND user_id=${input.userId}::uuid AND status='pending' AND expires_at<=clock_timestamp()`.execute(
        tx,
      );
      const pending =
        await sql`SELECT id FROM agent_drafts WHERE thread_id=${input.threadId}::uuid AND user_id=${input.userId}::uuid AND status IN ('pending','approved') LIMIT 1`.execute(
          tx,
        );
      if (pending.rows.length) throw new Error('DRAFT_PENDING');
      const messageId = uuidV7();
      await sql`INSERT INTO agent_messages(id,thread_id,role,text,client_message_id)
        VALUES(${messageId}::uuid,${input.threadId}::uuid,'user',${text},${input.clientMessageId}::uuid)
        ON CONFLICT(thread_id,client_message_id) DO NOTHING`.execute(tx);
      const message = await sql<{
        id: string;
        role: string;
        text: string;
      }>`SELECT id,role,text FROM agent_messages
        WHERE thread_id=${input.threadId}::uuid AND client_message_id=${input.clientMessageId}::uuid`.execute(
        tx,
      );
      if (!message.rows[0] || message.rows[0].role !== 'user' || message.rows[0].text !== text)
        throw new Error('IDEMPOTENCY_KEY_REUSED');
      const id = uuidV7();
      const inserted =
        await sql<Job>`INSERT INTO agent_jobs(id,thread_id,user_id,request_key,kind,client_message_id,message_id,locale,state)
        VALUES(${id}::uuid,${input.threadId}::uuid,${input.userId}::uuid,${key},'message',${input.clientMessageId}::uuid,${message.rows[0].id}::uuid,${input.locale},'queued') RETURNING *`.execute(
          tx,
        );
      await this.event(tx, id, { event: 'run.started', data: { runId: id } });
      return inserted.rows[0]!;
    });
    this.wake();
    return view(job);
  }

  async submitResume(input: {
    userId: string;
    threadId: string;
    draftId: string;
    decision: Decision;
    locale: AgentLocale;
    clientActionId?: string;
  }): Promise<AgentJobView> {
    const workerOnline = await this.redis.exists(this.heartbeatKey);
    const job = await this.db.transaction().execute(async (tx) => {
      await this.lockThread(tx, input.userId, input.threadId);
      const draft =
        await sql`SELECT id FROM agent_drafts WHERE id=${input.draftId}::uuid AND thread_id=${input.threadId}::uuid AND user_id=${input.userId}::uuid`.execute(
          tx,
        );
      if (!draft.rows.length) throw new Error('RESOURCE_NOT_FOUND');
      const key = `resume:${input.draftId}:${input.decision}:${input.clientActionId ?? 'legacy'}`;
      const previous =
        await sql<Job>`SELECT * FROM agent_jobs WHERE thread_id=${input.threadId}::uuid AND user_id=${input.userId}::uuid AND request_key=${key}`.execute(
          tx,
        );
      if (previous.rows[0]) return previous.rows[0];
      if (!workerOnline) throw new Error('AGENT_WORKER_UNAVAILABLE');
      const active =
        await sql`SELECT id FROM agent_jobs WHERE thread_id=${input.threadId}::uuid AND state IN ('queued','running') LIMIT 1`.execute(
          tx,
        );
      if (active.rows.length) throw new Error('RUN_IN_PROGRESS');
      const id = uuidV7();
      const inserted =
        await sql<Job>`INSERT INTO agent_jobs(id,thread_id,user_id,request_key,kind,draft_id,decision,locale,state)
        VALUES(${id}::uuid,${input.threadId}::uuid,${input.userId}::uuid,${key},'resume',${input.draftId}::uuid,${input.decision},${input.locale},'queued') RETURNING *`.execute(
          tx,
        );
      await this.event(tx, id, { event: 'run.started', data: { runId: id } });
      return inserted.rows[0]!;
    });
    this.wake();
    return view(job);
  }

  async current(userId: string, threadId: string): Promise<AgentJobView | null> {
    const rows =
      await sql<Job>`SELECT j.* FROM agent_jobs j JOIN agent_threads t ON t.id=j.thread_id
      WHERE j.thread_id=${threadId}::uuid AND j.user_id=${userId}::uuid AND t.user_id=${userId}::uuid
      ORDER BY j.created_at DESC,j.id DESC LIMIT 1`.execute(this.db);
    return rows.rows[0] ? view(rows.rows[0]) : null;
  }

  async follow(
    userId: string,
    threadId: string,
    jobId: string,
    after: string | undefined,
    signal: AbortSignal,
    emit: Emit,
  ): Promise<void> {
    if (after !== undefined && !/^\d{1,18}$/.test(after)) throw new Error('INVALID_INPUT');
    let cursor = after ?? '0';
    let ended = false;
    while (!signal.aborted) {
      const job = await sql<{
        state: State;
        error_code: string | null;
      }>`SELECT state,error_code FROM agent_jobs
        WHERE id=${jobId}::uuid AND thread_id=${threadId}::uuid AND user_id=${userId}::uuid`.execute(
        this.db,
      );
      if (!job.rows[0]) throw new Error('RESOURCE_NOT_FOUND');
      const events = await sql<{
        sequence: string;
        event: string;
        data: Record<string, unknown>;
      }>`SELECT sequence::text,event,data FROM agent_job_events
        WHERE job_id=${jobId}::uuid AND sequence>${cursor}::bigint ORDER BY sequence LIMIT 100`.execute(
        this.db,
      );
      for (const row of events.rows) {
        cursor = row.sequence;
        const event = {
          event: row.event,
          data: row.data,
          sequence: row.sequence,
        } as unknown as AgentEvent;
        emit(event);
        if (event.event === 'run.ended') ended = true;
      }
      if (ended) return;
      if (terminal(job.rows[0].state) && events.rows.length < 100) {
        if (job.rows[0].state === 'failed')
          emit({
            event: 'run.error',
            data: { code: job.rows[0].error_code ?? 'AGENT_UNAVAILABLE', retryable: true },
          });
        emit({ event: 'run.ended', data: {} });
        return;
      }
      if (events.rows.length < 100) await delay(300);
    }
  }

  async cancel(userId: string, threadId: string): Promise<void> {
    const id = await this.db.transaction().execute(async (tx) => {
      await this.lockThread(tx, userId, threadId, false);
      const rows =
        await sql<Job>`SELECT * FROM agent_jobs WHERE thread_id=${threadId}::uuid AND user_id=${userId}::uuid
        AND state IN ('queued','running') ORDER BY created_at DESC LIMIT 1 FOR UPDATE`.execute(tx);
      const job = rows.rows[0];
      if (!job) return null;
      if (job.state === 'queued') {
        await sql`UPDATE agent_jobs SET state='cancelled',cancel_requested=true,updated_at=clock_timestamp() WHERE id=${job.id}::uuid`.execute(
          tx,
        );
        await this.event(tx, job.id, { event: 'run.ended', data: {} });
      } else
        await sql`UPDATE agent_jobs SET cancel_requested=true,updated_at=clock_timestamp() WHERE id=${job.id}::uuid`.execute(
          tx,
        );
      return job.id;
    });
    if (id) this.active.get(id)?.abort.abort();
  }

  private wake(): void {
    if (this.timer) void this.tick();
  }
  private async event(tx: TransactionContext, jobId: string, event: AgentEvent): Promise<void> {
    await sql`INSERT INTO agent_job_events(job_id,event,data) VALUES(${jobId}::uuid,${event.event},${JSON.stringify(event.data as unknown as Json)}::jsonb)`.execute(
      tx,
    );
  }
  private async writeEvent(job: Job, event: AgentEvent): Promise<void> {
    await sql`INSERT INTO agent_job_events(job_id,event,data)
      SELECT id,${event.event},${JSON.stringify(event.data as unknown as Json)}::jsonb FROM agent_jobs
      WHERE id=${job.id}::uuid AND state='running' AND lease_token=${job.lease_token}::uuid`.execute(
      this.db,
    );
  }

  private async claim(): Promise<Job | null> {
    const token = randomUUID();
    return this.db.transaction().execute(async (tx) => {
      const rows = await sql<Job>`WITH next AS (
        SELECT id FROM agent_jobs WHERE state='queued' ORDER BY created_at,id FOR UPDATE SKIP LOCKED LIMIT 1
      ) UPDATE agent_jobs j SET state='running',lease_token=${token}::uuid,lease_until=clock_timestamp()+interval '180 seconds',updated_at=clock_timestamp()
        FROM next WHERE j.id=next.id RETURNING j.*`.execute(tx);
      return rows.rows[0] ?? null;
    });
  }

  private async tick(): Promise<void> {
    if (this.ticking || this.stopping) return;
    this.ticking = true;
    try {
      if (Date.now() - this.lastMaintenance > 60000) {
        this.lastMaintenance = Date.now();
        await this.recover();
      }
      while (!this.stopping && this.active.size < 2) {
        const job = await this.claim();
        if (!job) break;
        const abort = new AbortController();
        const promise = this.work(job, abort).finally(() => {
          this.active.delete(job.id);
          this.wake();
        });
        this.active.set(job.id, { abort, promise });
      }
      await this.redis.set(this.heartbeatKey, '1', 'EX', 10);
    } catch {
      // Database outages leave durable work queued; the next bounded scan retries.
    } finally {
      this.ticking = false;
    }
  }

  private async work(job: Job, abort: AbortController): Promise<void> {
    let writes = Promise.resolve();
    let failure: string | undefined;
    let waiting = false;
    let delta = '';
    let deltaTimer: ReturnType<typeof setTimeout> | undefined;
    const queueEvent = (event: AgentEvent) => {
      writes = writes
        .then(() => this.writeEvent(job, event))
        .catch(() => {
          failure = 'AGENT_UNAVAILABLE';
          abort.abort();
        });
    };
    const flushDelta = () => {
      if (deltaTimer) clearTimeout(deltaTimer);
      deltaTimer = undefined;
      if (!delta) return;
      const text = delta;
      delta = '';
      queueEvent({ event: 'message.delta', data: { text } });
    };
    const emit: Emit = (event) => {
      if (event.event === 'run.started' || event.event === 'run.ended') return;
      // LangGraph replays the interrupted tool when a decision resumes. Its
      // original confirmation is already on screen; it is not a new pause.
      if (job.kind === 'resume' && isReplayedConfirmation(event, job.draft_id)) return;
      if (event.event === 'message.delta') {
        delta += event.data.text;
        if (!deltaTimer) deltaTimer = setTimeout(flushDelta, 60);
        return;
      }
      flushDelta();
      if (event.event === 'draft.required') waiting = true;
      if (event.event === 'run.error') failure = event.data.code;
      queueEvent(event);
    };
    let checking = false;
    const timer = setInterval(() => {
      if (checking) return;
      checking = true;
      void (async () => {
        // A checkout can hold this job row while it commits. Do not wait on our
        // own transaction until statement_timeout and then abort a valid order.
        const rows = await sql<{ cancel_requested: boolean }>`WITH available AS (
          SELECT id FROM agent_jobs WHERE id=${job.id}::uuid AND state='running'
            AND lease_token=${job.lease_token}::uuid AND lease_until>clock_timestamp()
            FOR UPDATE SKIP LOCKED
        ) UPDATE agent_jobs j SET lease_until=clock_timestamp()+interval '180 seconds',updated_at=clock_timestamp()
          FROM available WHERE j.id=available.id RETURNING j.cancel_requested`.execute(this.db);
        if (!rows.rows[0]) {
          const current = await sql<{ valid: boolean; cancel_requested: boolean }>`SELECT
            state='running' AND lease_token=${job.lease_token}::uuid AND lease_until>clock_timestamp() AS valid,
            cancel_requested FROM agent_jobs WHERE id=${job.id}::uuid`.execute(this.db);
          if (!current.rows[0]?.valid || current.rows[0].cancel_requested) {
            abort.abort();
            return;
          }
        } else if (rows.rows[0].cancel_requested) {
          abort.abort();
          return;
        }
        await this.authorize(job.user_id, job.thread_id);
      })()
        .catch(() => abort.abort())
        .finally(() => {
          checking = false;
        });
    }, 5000);
    timer.unref();
    try {
      await this.authorize(job.user_id, job.thread_id);
      const message = job.message_id
        ? await sql<{
            text: string;
          }>`SELECT text FROM agent_messages WHERE id=${job.message_id}::uuid AND thread_id=${job.thread_id}::uuid`.execute(
            this.db,
          )
        : null;
      if (job.kind === 'message' && !message?.rows[0]) throw new Error('RESOURCE_NOT_FOUND');
      if (!job.lease_token) throw new Error('RUN_ABORTED');
      await withAgentJobLease(
        {
          jobId: job.id,
          leaseToken: job.lease_token,
          userId: job.user_id,
          threadId: job.thread_id,
        },
        () => this.execute(job, message?.rows[0]?.text ?? null, abort.signal, emit),
      );
    } catch (error) {
      failure =
        error instanceof Error &&
        [
          'RUN_IN_PROGRESS',
          'AGENT_DAILY_LIMIT',
          'DRAFT_PENDING',
          'INVALID_INPUT',
          'IDEMPOTENCY_KEY_REUSED',
        ].includes(error.message)
          ? error.message
          : 'AGENT_UNAVAILABLE';
      emit({
        event: 'run.error',
        data: { code: failure, retryable: failure === 'AGENT_UNAVAILABLE' },
      });
    } finally {
      clearInterval(timer);
      flushDelta();
      await writes;
      const current = await sql<{
        cancel_requested: boolean;
      }>`SELECT cancel_requested FROM agent_jobs WHERE id=${job.id}::uuid AND lease_token=${job.lease_token}::uuid`
        .execute(this.db)
        .catch(() => ({ rows: [] }));
      const state: State = current.rows[0]?.cancel_requested
        ? 'cancelled'
        : failure || abort.signal.aborted
          ? 'failed'
          : waiting
            ? 'waiting'
            : 'completed';
      await this.finish(job, state, failure).catch(() => undefined);
    }
  }

  private async finish(job: Job, state: State, errorCode?: string): Promise<void> {
    await this.db.transaction().execute(async (tx) => {
      const locked = await sql<{
        cancel_requested: boolean;
      }>`SELECT cancel_requested FROM agent_jobs
        WHERE id=${job.id}::uuid AND state='running' AND lease_token=${job.lease_token}::uuid FOR UPDATE`.execute(
        tx,
      );
      if (!locked.rows[0]) return;
      const outcome: State = locked.rows[0].cancel_requested ? 'cancelled' : state;
      await sql`UPDATE agent_jobs SET state=${outcome},error_code=${errorCode ?? null},lease_token=NULL,lease_until=NULL,updated_at=clock_timestamp()
        WHERE id=${job.id}::uuid AND state='running' AND lease_token=${job.lease_token}::uuid`.execute(
        tx,
      );
      await sql`UPDATE agent_runs SET outcome='failed',error_code=COALESCE(error_code,'AGENT_UNAVAILABLE') WHERE thread_id=${job.thread_id}::uuid AND user_id=${job.user_id}::uuid AND outcome='running' AND ${outcome} IN ('failed','cancelled')`.execute(
        tx,
      );
      if (outcome === 'failed' && !errorCode)
        await this.event(tx, job.id, {
          event: 'run.error',
          data: { code: 'AGENT_UNAVAILABLE', retryable: true },
        });
      await this.event(tx, job.id, { event: 'run.ended', data: {} });
      if (outcome === 'cancelled') return;
      // Sent even while the chat is open. Cancelled runs return above and send nothing.
      const eventType =
        outcome === 'waiting'
          ? 'AGENT_RUN_WAITING'
          : outcome === 'failed'
            ? 'AGENT_RUN_FAILED'
            : 'AGENT_RUN_READY';
      await appendEvent(
        tx,
        {
          eventId: uuidV7(),
          eventType,
          schemaVersion: 1,
          aggregateType: 'agent_run',
          aggregateId: job.id,
          aggregateVersion: '1',
          occurredAt: new Date().toISOString(),
          correlationId: job.id,
          causationId: null,
          payload: { userId: job.user_id, threadId: job.thread_id },
        },
        ['notifications'],
      );
    });
  }

  private async recover(): Promise<void> {
    // Do not replay an interrupted graph: a tool may already have committed.
    for (let i = 0; i < 20; i++) {
      const token = randomUUID();
      const stale = await sql<Job>`WITH expired AS (
        SELECT id FROM agent_jobs WHERE state='running' AND lease_until<clock_timestamp()
        ORDER BY lease_until FOR UPDATE SKIP LOCKED LIMIT 1
      ) UPDATE agent_jobs j SET lease_token=${token}::uuid,lease_until=clock_timestamp()+interval '60 seconds'
        FROM expired WHERE j.id=expired.id RETURNING j.*`.execute(this.db);
      const job = stale.rows[0];
      if (!job) break;
      await this.writeEvent(job, {
        event: 'run.error',
        data: { code: 'AGENT_UNAVAILABLE', retryable: false },
      });
      await this.finish(job, 'failed', 'AGENT_UNAVAILABLE');
    }
    await sql`DELETE FROM agent_job_events e USING agent_jobs j WHERE e.job_id=j.id AND j.state NOT IN ('queued','running')
      AND j.updated_at<clock_timestamp()-interval '24 hours'`.execute(this.db);
  }
}
