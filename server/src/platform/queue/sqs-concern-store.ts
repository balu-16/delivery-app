import { createHash, randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { CronExpressionParser } from 'cron-parser';
import { type Database, type Json } from '../database/database.js';
import { CONCERNS, type FailedConcernJob, type QueueConcern, type Schedule } from './concerns.js';
import type { SqsJobPointer } from './sqs-transport.js';

export interface ClaimedConcernSend {
  concern: QueueConcern;
  pointer: SqsJobPointer;
  token: string;
}
export interface ClaimedConcernJob {
  name: string;
  payload: Json;
  token: string;
  attempt: number;
}
export type ConcernClaim =
  { kind: 'claimed'; job: ClaimedConcernJob } | { kind: 'busy' | 'terminal' | 'failed' };

function validate(concern: QueueConcern, name: string): void {
  if (!CONCERNS.includes(concern) || !/^[a-z][a-z0-9_-]{0,63}$/.test(name))
    throw new Error('INVALID_CONCERN_JOB');
}

function nextSchedule(schedule: Schedule, after: Date): Date {
  if ('everyMs' in schedule) {
    if (
      !Number.isSafeInteger(schedule.everyMs) ||
      schedule.everyMs < 100 ||
      schedule.everyMs > 31536000000
    )
      throw new Error('INVALID_SCHEDULE');
    return new Date(after.getTime() + schedule.everyMs);
  }
  if (!schedule.pattern || schedule.pattern.length > 128) throw new Error('INVALID_SCHEDULE');
  try {
    return CronExpressionParser.parse(schedule.pattern, { currentDate: after, tz: 'Asia/Kolkata' })
      .next()
      .toDate();
  } catch {
    throw new Error('INVALID_SCHEDULE');
  }
}

/** Aurora owns durable obligations; SQS messages only identify their current generation. */
export class SqsConcernStore {
  constructor(private readonly db: Database) {}

  async enqueue(
    concern: QueueConcern,
    name: string,
    payload: Json,
    operationId: string,
  ): Promise<string> {
    validate(concern, name);
    if (!operationId || operationId.length > 512) throw new Error('INVALID_OPERATION_ID');
    const id = createHash('sha256').update(`${name}\0${operationId}`).digest('hex');
    await sql`INSERT INTO sqs_concern_jobs(concern,id,name,payload) VALUES (${concern},${id},${name},${JSON.stringify(payload)}::jsonb)
      ON CONFLICT (concern,id) DO UPDATE SET generation=sqs_concern_jobs.generation+1,state='QUEUED',payload=EXCLUDED.payload,
        attempts=0,available_at=clock_timestamp(),next_send_at=clock_timestamp(),send_token=NULL,send_until=NULL,updated_at=clock_timestamp()
      WHERE sqs_concern_jobs.state='COMPLETED'`.execute(this.db);
    return id;
  }

  async claimDue(limit = 50): Promise<ClaimedConcernSend[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500)
      throw new Error('INVALID_CONCERN_CLAIM');
    const token = randomUUID();
    const result = await sql<{
      concern: QueueConcern;
      id: string;
      generation: number;
    }>`WITH due AS (
      SELECT concern,id FROM sqs_concern_jobs
      WHERE next_send_at <= clock_timestamp() AND (send_until IS NULL OR send_until <= clock_timestamp())
        AND (state='QUEUED' OR (state='RUNNING' AND lease_until <= clock_timestamp()))
      ORDER BY next_send_at,concern,id FOR UPDATE SKIP LOCKED LIMIT ${limit}
    ) UPDATE sqs_concern_jobs j SET send_token=${token}::uuid,send_until=clock_timestamp()+interval '30 seconds',updated_at=clock_timestamp()
      FROM due WHERE j.concern=due.concern AND j.id=due.id RETURNING j.concern,j.id,j.generation`.execute(
      this.db,
    );
    return result.rows.map((row) => ({
      concern: row.concern,
      pointer: { version: 1, jobId: row.id, generation: row.generation },
      token,
    }));
  }

  async sent(send: ClaimedConcernSend): Promise<void> {
    await sql`UPDATE sqs_concern_jobs SET send_token=NULL,send_until=NULL,next_send_at=clock_timestamp()+interval '60 seconds',updated_at=clock_timestamp()
      WHERE concern=${send.concern} AND id=${send.pointer.jobId} AND generation=${send.pointer.generation} AND send_token=${send.token}::uuid`.execute(
      this.db,
    );
  }

  async sendFailed(send: ClaimedConcernSend): Promise<void> {
    await sql`UPDATE sqs_concern_jobs SET send_token=NULL,send_until=NULL,next_send_at=clock_timestamp()+interval '5 seconds',updated_at=clock_timestamp()
      WHERE concern=${send.concern} AND id=${send.pointer.jobId} AND generation=${send.pointer.generation} AND send_token=${send.token}::uuid`.execute(
      this.db,
    );
  }

  async acquire(concern: QueueConcern, pointer: SqsJobPointer): Promise<ConcernClaim> {
    if (
      !CONCERNS.includes(concern) ||
      !/^[0-9a-f]{64}$/.test(pointer.jobId) ||
      pointer.version !== 1 ||
      !Number.isSafeInteger(pointer.generation) ||
      pointer.generation < 1
    )
      throw new Error('INVALID_CONCERN_POINTER');
    const token = randomUUID();
    // A worker can die without recording a failure. Bound those expired leases too.
    await sql`UPDATE sqs_concern_jobs SET state='FAILED',failed_at=clock_timestamp(),lease_token=NULL,lease_until=NULL,send_token=NULL,send_until=NULL,updated_at=clock_timestamp()
      WHERE concern=${concern} AND id=${pointer.jobId} AND generation=${pointer.generation}
        AND state='RUNNING' AND lease_until<=clock_timestamp() AND attempts>=5`.execute(this.db);
    const result = await sql<{
      name: string;
      payload: Json;
      attempts: number;
    }>`UPDATE sqs_concern_jobs
      SET state='RUNNING',lease_token=${token}::uuid,lease_until=clock_timestamp()+interval '120 seconds',attempts=attempts+1,send_token=NULL,send_until=NULL,updated_at=clock_timestamp()
      WHERE concern=${concern} AND id=${pointer.jobId} AND generation=${pointer.generation} AND attempts<5
        AND ((state='QUEUED' AND available_at <= clock_timestamp()) OR (state='RUNNING' AND lease_until <= clock_timestamp()))
      RETURNING name,payload,attempts`.execute(this.db);
    const row = result.rows[0];
    if (row)
      return {
        kind: 'claimed',
        job: { name: row.name, payload: row.payload, token, attempt: row.attempts },
      };
    const current = await sql<{
      state: string;
      generation: number;
    }>`SELECT state,generation FROM sqs_concern_jobs WHERE concern=${concern} AND id=${pointer.jobId}`.execute(
      this.db,
    );
    const existing = current.rows[0];
    if (!existing || existing.generation !== pointer.generation || existing.state === 'COMPLETED')
      return { kind: 'terminal' };
    if (existing.state === 'FAILED') return { kind: 'failed' };
    return { kind: 'busy' };
  }

  async heartbeat(concern: QueueConcern, pointer: SqsJobPointer, token: string): Promise<boolean> {
    const result =
      await sql`UPDATE sqs_concern_jobs SET lease_until=clock_timestamp()+interval '120 seconds',updated_at=clock_timestamp()
      WHERE concern=${concern} AND id=${pointer.jobId} AND generation=${pointer.generation} AND state='RUNNING' AND lease_token=${token}::uuid AND lease_until>clock_timestamp()`.execute(
        this.db,
      );
    return Number(result.numAffectedRows ?? 0) === 1;
  }

  async finish(concern: QueueConcern, pointer: SqsJobPointer, token: string): Promise<boolean> {
    const result =
      await sql`UPDATE sqs_concern_jobs SET state='COMPLETED',lease_token=NULL,lease_until=NULL,send_token=NULL,send_until=NULL,updated_at=clock_timestamp()
      WHERE concern=${concern} AND id=${pointer.jobId} AND generation=${pointer.generation} AND state='RUNNING' AND lease_token=${token}::uuid AND lease_until>clock_timestamp()`.execute(
        this.db,
      );
    return Number(result.numAffectedRows ?? 0) === 1;
  }

  async fail(
    concern: QueueConcern,
    pointer: SqsJobPointer,
    token: string,
    maxAttempts = 5,
  ): Promise<boolean> {
    if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 100)
      throw new Error('INVALID_ATTEMPT_LIMIT');
    const jitter = Math.random();
    const result =
      await sql`UPDATE sqs_concern_jobs SET state=CASE WHEN attempts>=${maxAttempts} THEN 'FAILED' ELSE 'QUEUED' END,
      failed_at=CASE WHEN attempts>=${maxAttempts} THEN clock_timestamp() ELSE NULL END,lease_token=NULL,lease_until=NULL,
      available_at=statement_timestamp()+(LEAST(300,power(2,LEAST(attempts,8)))+${jitter})*interval '1 second',
      next_send_at=statement_timestamp()+(LEAST(300,power(2,LEAST(attempts,8)))+${jitter})*interval '1 second',updated_at=clock_timestamp()
      WHERE concern=${concern} AND id=${pointer.jobId} AND generation=${pointer.generation} AND state='RUNNING' AND lease_token=${token}::uuid AND lease_until>clock_timestamp()`.execute(
        this.db,
      );
    return Number(result.numAffectedRows ?? 0) === 1;
  }

  async listFailed(concern: QueueConcern, limit = 50): Promise<FailedConcernJob[]> {
    if (!CONCERNS.includes(concern) || !Number.isSafeInteger(limit) || limit < 1 || limit > 500)
      throw new Error('INVALID_FAILED_JOB_LIMIT');
    const result = await sql<{
      id: string;
      name: string;
      attempts: number;
      failed_at: Date;
    }>`SELECT id,name,attempts,failed_at FROM sqs_concern_jobs WHERE concern=${concern} AND state='FAILED' ORDER BY failed_at DESC,id LIMIT ${limit}`.execute(
      this.db,
    );
    return result.rows.map((row) => ({
      id: row.id,
      name: row.name,
      attempts: row.attempts,
      failedAt: row.failed_at.getTime(),
    }));
  }

  async getFailed(concern: QueueConcern, id: string): Promise<FailedConcernJob | null> {
    if (!CONCERNS.includes(concern) || !/^[0-9a-f]{64}$/.test(id)) return null;
    const result = await sql<{
      id: string;
      name: string;
      attempts: number;
      failed_at: Date;
    }>`SELECT id,name,attempts,failed_at FROM sqs_concern_jobs WHERE concern=${concern} AND id=${id} AND state='FAILED'`.execute(
      this.db,
    );
    const row = result.rows[0];
    return row
      ? { id: row.id, name: row.name, attempts: row.attempts, failedAt: row.failed_at.getTime() }
      : null;
  }

  async replay(concern: QueueConcern, id: string): Promise<void> {
    if (!CONCERNS.includes(concern) || !/^[0-9a-f]{64}$/.test(id))
      throw new Error('FAILED_JOB_NOT_FOUND');
    const result =
      await sql`UPDATE sqs_concern_jobs SET generation=generation+1,state='QUEUED',attempts=0,failed_at=NULL,available_at=clock_timestamp(),next_send_at=clock_timestamp(),send_token=NULL,send_until=NULL,updated_at=clock_timestamp() WHERE concern=${concern} AND id=${id} AND state='FAILED'`.execute(
        this.db,
      );
    if (Number(result.numAffectedRows ?? 0) !== 1) throw new Error('FAILED_JOB_NOT_FOUND');
  }

  async upsertScheduler(
    concern: QueueConcern,
    schedulerId: string,
    name: string,
    payload: Json,
    schedule: Schedule,
  ): Promise<void> {
    validate(concern, name);
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(schedulerId)) throw new Error('INVALID_SCHEDULER_ID');
    const result = await sql<{ now: Date }>`SELECT clock_timestamp() AS now`.execute(this.db);
    const next = nextSchedule(schedule, result.rows[0]!.now);
    const json = JSON.stringify(schedule);
    await sql`INSERT INTO sqs_concern_schedules(concern,scheduler_id,name,payload,schedule,next_run_at)
      VALUES (${concern},${schedulerId},${name},${JSON.stringify(payload)}::jsonb,${json}::jsonb,${next.toISOString()}::timestamptz)
      ON CONFLICT (concern,scheduler_id) DO UPDATE SET name=EXCLUDED.name,payload=EXCLUDED.payload,
        next_run_at=CASE WHEN sqs_concern_schedules.schedule=EXCLUDED.schedule THEN sqs_concern_schedules.next_run_at ELSE EXCLUDED.next_run_at END,
        schedule=EXCLUDED.schedule,updated_at=clock_timestamp()`.execute(this.db);
  }

  async tickSchedules(limit = 50): Promise<number> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500)
      throw new Error('INVALID_SCHEDULE_LIMIT');
    return this.db.transaction().execute(async (tx) => {
      const result = await sql<{
        concern: QueueConcern;
        scheduler_id: string;
        name: string;
        payload: Json;
        schedule: Schedule;
        next_run_at: Date;
        now: Date;
      }>`SELECT concern,scheduler_id,name,payload,schedule,next_run_at,clock_timestamp() AS now
        FROM sqs_concern_schedules WHERE next_run_at <= clock_timestamp() ORDER BY next_run_at,concern,scheduler_id FOR UPDATE SKIP LOCKED LIMIT ${limit}`.execute(
        tx,
      );
      for (const row of result.rows) {
        const operationId = `${row.scheduler_id}:${row.next_run_at.toISOString()}`;
        const id = createHash('sha256').update(`${row.name}\0${operationId}`).digest('hex');
        await sql`INSERT INTO sqs_concern_jobs(concern,id,name,payload) VALUES (${row.concern},${id},${row.name},${JSON.stringify(row.payload)}::jsonb) ON CONFLICT (concern,id) DO NOTHING`.execute(
          tx,
        );
        const next = nextSchedule(row.schedule, row.now);
        await sql`UPDATE sqs_concern_schedules SET next_run_at=${next.toISOString()}::timestamptz,updated_at=clock_timestamp() WHERE concern=${row.concern} AND scheduler_id=${row.scheduler_id}`.execute(
          tx,
        );
      }
      return result.rows.length;
    });
  }

  async depths(): Promise<
    Array<{
      concern: QueueConcern;
      waiting: number;
      active: number;
      delayed: number;
      failed: number;
    }>
  > {
    const result = await sql<{
      concern: QueueConcern;
      waiting: string;
      active: string;
      delayed: string;
      failed: string;
    }>`SELECT concern,
      count(*) FILTER (WHERE state='QUEUED' AND available_at<=clock_timestamp())::text AS waiting,
      count(*) FILTER (WHERE state='RUNNING')::text AS active,
      count(*) FILTER (WHERE state='QUEUED' AND available_at>clock_timestamp())::text AS delayed,
      count(*) FILTER (WHERE state='FAILED')::text AS failed
      FROM sqs_concern_jobs GROUP BY concern`.execute(this.db);
    return CONCERNS.map((concern) => {
      const row = result.rows.find((entry) => entry.concern === concern);
      return {
        concern,
        waiting: Number(row?.waiting ?? 0),
        active: Number(row?.active ?? 0),
        delayed: Number(row?.delayed ?? 0),
        failed: Number(row?.failed ?? 0),
      };
    });
  }
}
