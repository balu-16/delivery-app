import { resolve } from 'node:path';
import { runner } from 'node-pg-migrate';
import { sql } from 'kysely';
import type { Redis } from 'ioredis';
import { uuidV7 } from '../../../src/common/ids/ids.js';
import { createDatabase, type DatabaseHandle } from '../../../src/platform/database/database.js';
import { AgentJobs } from '../../../src/modules/agent/infrastructure/jobs.js';
import { AgentThreads } from '../../../src/modules/agent/infrastructure/threads.js';
import { AgentDrafts } from '../../../src/modules/agent/infrastructure/drafts.js';
import type { AgentEvent } from '../../../src/modules/agent/contracts/agent.js';
import { startTestServices, type TestServices } from '../../helpers/services.js';
import { assertDisposableAgentDatabase } from './disposable-database.js';
import {
  assertAgentCommitAllowed,
  withAgentJobLease,
} from '../../../src/modules/agent/infrastructure/security.js';
import { ConfigService } from '../../../src/modules/app-config/infrastructure/config-service.js';
import { PostgresNotificationPipeline } from '../../../src/modules/notifications/infrastructure/postgres-pipeline.js';
import type {
  EmailPort,
  PushPort,
} from '../../../src/modules/notifications/contracts/notifications.js';

let services: TestServices, db: DatabaseHandle, customer: string, stranger: string;
const redis = { exists: async () => 1, set: async () => 'OK' } as unknown as Redis;
const authorize = async () => undefined;

beforeAll(async () => {
  services = await startTestServices({ skipAwsCache: true });
  await runner({
    databaseUrl: services.databaseUrl,
    dir: resolve('db/migrations'),
    direction: 'up',
    migrationsTable: 'pgmigrations',
    log: () => undefined,
  });
  db = createDatabase(services.databaseUrl, 4, 10000, undefined, 30000);
  await assertDisposableAgentDatabase(db.db);
  customer = uuidV7();
  stranger = uuidV7();
  await sql`INSERT INTO users(id,pool,cognito_sub,normalized_email,name,email_verified) VALUES
    (${customer}::uuid,'CUSTOMER',${`background-${customer}`},${`${customer}@example.test`},'Customer',true),
    (${stranger}::uuid,'CUSTOMER',${`background-${stranger}`},${`${stranger}@example.test`},'Other',true)`.execute(
    db.db,
  );
  await sql`INSERT INTO consents(user_id,type,version) VALUES(${customer}::uuid,'ai_assistant','1')`.execute(
    db.db,
  );
  await sql`INSERT INTO feature_flags(key,enabled) VALUES('agent_enabled',true) ON CONFLICT(key) DO UPDATE SET enabled=true`.execute(
    db.db,
  );
}, 300000);

afterAll(async () => {
  await db?.close();
  await services?.stop();
}, 300000);

async function newThread(): Promise<string> {
  // Each test archives its old thread because the schema permits one active thread per customer.
  await sql`UPDATE agent_threads SET status='archived' WHERE user_id=${customer}::uuid AND status='active'`.execute(
    db.db,
  );
  const id = uuidV7();
  await sql`INSERT INTO agent_threads(id,user_id) VALUES(${id}::uuid,${customer}::uuid)`.execute(
    db.db,
  );
  return id;
}

async function waitForState(
  jobs: AgentJobs,
  threadId: string,
  expected: string,
  attempts = 100,
): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    if ((await jobs.current(customer, threadId))?.state === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${expected}`);
}

test('disconnecting a viewer leaves one durable run and one completion event', async () => {
  const threadId = await newThread(),
    clientMessageId = uuidV7();
  let release!: () => void, started!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const began = new Promise<void>((resolve) => {
    started = resolve;
  });
  let executions = 0;
  const jobs = new AgentJobs(
    db.db,
    redis,
    'test:agent:worker',
    async (_job, _text, _signal, emit) => {
      executions++;
      emit({
        event: 'tool.status',
        data: { labelKey: 'agent.activity.findProducts', phase: 'start' },
      });
      started();
      await gate;
      emit({ event: 'message.delta', data: { text: 'Your items are ready.' } });
    },
    authorize,
  );
  await jobs.start();
  try {
    const input = {
      userId: customer,
      threadId,
      clientMessageId,
      text: 'Find milk',
      locale: 'en' as const,
    };
    const job = await jobs.submitMessage(input);
    const duplicate = await jobs.submitMessage(input);
    expect(duplicate.id).toBe(job.id);
    await began;
    const controller = new AbortController(),
      events: AgentEvent[] = [];
    const following = jobs.follow(
      customer,
      threadId,
      job.id,
      undefined,
      controller.signal,
      (event) => {
        events.push(event);
        if (event.event === 'run.started') controller.abort();
      },
    );
    await following;
    release();
    await waitForState(jobs, threadId, 'completed');
    const notification = await sql<{
      count: string;
    }>`SELECT count(*)::text AS count FROM outbox_events
      WHERE aggregate_id=${job.id}::uuid AND event_type='AGENT_RUN_READY'`.execute(db.db);
    expect(executions).toBe(1);
    expect(events.some((event) => event.event === 'run.started')).toBe(true);
    expect(notification.rows[0]?.count).toBe('1');
    await expect(
      jobs.follow(
        stranger,
        threadId,
        job.id,
        undefined,
        new AbortController().signal,
        () => undefined,
      ),
    ).rejects.toThrow('RESOURCE_NOT_FOUND');
  } finally {
    release();
    await jobs.stop();
  }
}, 30000);

test('a confirmation pause sends an attention event rather than a completion claim', async () => {
  const threadId = await newThread();
  const jobs = new AgentJobs(
    db.db,
    redis,
    'test:agent:worker',
    async (_job, _text, _signal, emit) => {
      emit({
        event: 'draft.required',
        data: {
          draftId: uuidV7(),
          type: 'order',
          expiresAt: new Date(Date.now() + 60000).toISOString(),
        },
      });
    },
    authorize,
  );
  await jobs.start();
  try {
    const job = await jobs.submitMessage({
      userId: customer,
      threadId,
      clientMessageId: uuidV7(),
      text: 'Order milk',
      locale: 'en',
    });
    await waitForState(jobs, threadId, 'waiting');
    const events = await sql<{
      event_type: string;
    }>`SELECT event_type FROM outbox_events WHERE aggregate_id=${job.id}::uuid`.execute(db.db);
    expect(events.rows.map((row) => row.event_type)).toEqual(['AGENT_RUN_WAITING']);
  } finally {
    await jobs.stop();
  }
}, 30000);

test('resuming a confirmation does not report its replayed card as a new pause', async () => {
  const threadId = await newThread(),
    drafts = new AgentDrafts(db.db);
  const draft = await drafts.prepare({
    userId: customer,
    threadId,
    toolCallId: uuidV7(),
    type: 'order',
    payload: {},
    expiresAt: new Date(Date.now() + 120000),
  });
  const jobs = new AgentJobs(
    db.db,
    redis,
    'test:agent:worker',
    async (_job, _text, _signal, emit) => {
      emit({
        event: 'card',
        data: { cardId: draft.id, type: 'order_confirm', payload: { draftId: draft.id } },
      });
      emit({
        event: 'draft.required',
        data: { draftId: draft.id, type: 'order', expiresAt: draft.expires_at.toISOString() },
      });
      emit({ event: 'message.delta', data: { text: 'Your order was confirmed.' } });
    },
    authorize,
  );
  await jobs.start();
  try {
    const job = await jobs.submitResume({
      userId: customer,
      threadId,
      draftId: draft.id,
      decision: 'approve',
      locale: 'en',
    });
    await waitForState(jobs, threadId, 'completed');
    const events = await sql<{
      event: string;
    }>`SELECT event FROM agent_job_events WHERE job_id=${job.id}::uuid`.execute(db.db);
    expect(events.rows.some((row) => row.event === 'draft.required' || row.event === 'card')).toBe(
      false,
    );
    const notifications = await sql<{
      event_type: string;
    }>`SELECT event_type FROM outbox_events WHERE aggregate_id=${job.id}::uuid`.execute(db.db);
    expect(notifications.rows.map((row) => row.event_type)).toEqual(['AGENT_RUN_READY']);
  } finally {
    await jobs.stop();
  }
}, 90000);

test('the lease heartbeat does not abort a transaction holding its own job row', async () => {
  const threadId = await newThread();
  let abortedWhileLocked = false;
  const jobs = new AgentJobs(
    db.db,
    redis,
    'test:agent:worker',
    async (_job, _text, signal) => {
      await db.db.transaction().execute(async (tx) => {
        await assertAgentCommitAllowed(tx, customer, threadId);
        await new Promise((resolve) => setTimeout(resolve, 17000));
        abortedWhileLocked = signal.aborted;
      });
    },
    authorize,
  );
  await jobs.start();
  try {
    await jobs.submitMessage({
      userId: customer,
      threadId,
      clientMessageId: uuidV7(),
      text: 'Order milk',
      locale: 'en',
    });
    await waitForState(jobs, threadId, 'completed', 250);
    expect(abortedWhileLocked).toBe(false);
  } finally {
    await jobs.stop();
  }
}, 120000);

test('explicitly cancelling a queued run does not execute it or enqueue a push', async () => {
  const threadId = await newThread();
  let executions = 0;
  const jobs = new AgentJobs(
    db.db,
    redis,
    'test:agent:worker',
    async () => {
      executions++;
    },
    authorize,
  );
  const job = await jobs.submitMessage({
    userId: customer,
    threadId,
    clientMessageId: uuidV7(),
    text: 'Find milk',
    locale: 'en',
  });
  await jobs.cancel(customer, threadId);
  expect((await jobs.current(customer, threadId))?.state).toBe('cancelled');
  const events = await sql<{
    count: string;
  }>`SELECT count(*)::text AS count FROM outbox_events WHERE aggregate_id=${job.id}::uuid`.execute(
    db.db,
  );
  expect(executions).toBe(0);
  expect(events.rows[0]?.count).toBe('0');
});

test('stopping a running job cancels it without a second execution', async () => {
  const threadId = await newThread();
  let executions = 0;
  let started!: () => void;
  const began = new Promise<void>((resolve) => {
    started = resolve;
  });
  const jobs = new AgentJobs(
    db.db,
    redis,
    'test:agent:worker',
    async (_job, _text, signal) => {
      executions += 1;
      started();
      await new Promise<void>((resolve) => {
        signal.addEventListener('abort', () => resolve());
      });
    },
    authorize,
  );
  await jobs.start();
  try {
    await jobs.submitMessage({
      userId: customer,
      threadId,
      clientMessageId: uuidV7(),
      text: 'Find milk',
      locale: 'en',
    });
    await began;
    await jobs.cancel(customer, threadId);
    await waitForState(jobs, threadId, 'cancelled');
    expect(executions).toBe(1);
  } finally {
    await jobs.stop();
  }
}, 30000);

test('only the current uncancelled worker lease may commit', async () => {
  const threadId = await newThread();
  const messageId = uuidV7();
  const jobId = uuidV7();
  const leaseToken = uuidV7();
  const lease = { jobId, leaseToken, userId: customer, threadId };
  const commit = () =>
    withAgentJobLease(lease, () =>
      db.db.transaction().execute((tx) => assertAgentCommitAllowed(tx, customer, threadId)),
    );
  await sql`INSERT INTO agent_messages(id,thread_id,role,text) VALUES(${messageId}::uuid,${threadId}::uuid,'user','Find milk')`.execute(
    db.db,
  );
  await sql`INSERT INTO agent_jobs(id,thread_id,user_id,request_key,kind,client_message_id,message_id,locale,state,lease_token,lease_until)
    VALUES(${jobId}::uuid,${threadId}::uuid,${customer}::uuid,'lease-check','message',${uuidV7()}::uuid,${messageId}::uuid,'en','running',${leaseToken}::uuid,clock_timestamp()-interval '1 minute')`.execute(
    db.db,
  );
  await expect(commit()).rejects.toThrow('RUN_ABORTED');
  await sql`UPDATE agent_jobs SET lease_until=clock_timestamp()+interval '2 minutes',cancel_requested=false WHERE id=${jobId}::uuid`.execute(
    db.db,
  );
  await expect(commit()).resolves.toBeUndefined();
  await expect(
    db.db.transaction().execute((tx) => assertAgentCommitAllowed(tx, customer, threadId)),
  ).rejects.toThrow('RUN_IN_PROGRESS');
  await sql`UPDATE agent_jobs SET cancel_requested=true WHERE id=${jobId}::uuid`.execute(db.db);
  await expect(commit()).rejects.toThrow('RUN_ABORTED');
  await sql`UPDATE agent_jobs SET cancel_requested=false,lease_token=${uuidV7()}::uuid WHERE id=${jobId}::uuid`.execute(
    db.db,
  );
  await expect(commit()).rejects.toThrow('RUN_ABORTED');
  await sql`UPDATE agent_jobs SET state='failed',lease_token=NULL,lease_until=NULL WHERE id=${jobId}::uuid`.execute(
    db.db,
  );
  await expect(commit()).rejects.toThrow('RUN_ABORTED');
  await expect(
    db.db.transaction().execute((tx) => assertAgentCommitAllowed(tx, customer, threadId)),
  ).resolves.toBeUndefined();
});

test('a stopped worker cannot execute an already prepared confirmation', async () => {
  const threadId = await newThread(),
    drafts = new AgentDrafts(db.db);
  const draft = await drafts.prepare({
    userId: customer,
    threadId,
    toolCallId: uuidV7(),
    type: 'cancel',
    payload: { orderId: uuidV7() },
    expiresAt: new Date(Date.now() + 60000),
  });
  const jobId = uuidV7(),
    token = uuidV7(),
    messageId = uuidV7();
  await sql`INSERT INTO agent_messages(id,thread_id,role,text) VALUES(${messageId}::uuid,${threadId}::uuid,'user','Cancel my order')`.execute(
    db.db,
  );
  await sql`INSERT INTO agent_jobs(id,thread_id,user_id,request_key,kind,client_message_id,message_id,locale,state,lease_token,lease_until,cancel_requested)
    VALUES(${jobId}::uuid,${threadId}::uuid,${customer}::uuid,'cancel-fence','message',${uuidV7()}::uuid,${messageId}::uuid,'en','running',${token}::uuid,clock_timestamp()+interval '2 minutes',true)`.execute(
    db.db,
  );
  let executions = 0;
  await expect(
    withAgentJobLease({ jobId, leaseToken: token, userId: customer, threadId }, () =>
      drafts.decide(
        { userId: customer, threadId, draftId: draft.id, decision: 'approve' },
        async () => {
          executions++;
          return { cancelled: true };
        },
      ),
    ),
  ).rejects.toThrow('RUN_ABORTED');
  expect(executions).toBe(0);
  expect((await drafts.byCall(customer, threadId, draft.tool_call_id))?.status).toBe('pending');
});

test('history pagination retains messages that differ only by microseconds', async () => {
  const threadId = await newThread();
  const ids = Array.from({ length: 52 }, () => uuidV7());
  await sql`INSERT INTO agent_messages(id,thread_id,role,text,created_at)
    SELECT id,${threadId}::uuid,'user','Synthetic message',
      '2026-01-01T00:00:00Z'::timestamptz + n * interval '1 microsecond'
    FROM unnest(${ids}::uuid[]) WITH ORDINALITY AS item(id,n)`.execute(db.db);
  const threads = new AgentThreads(db.db);
  const first = await threads.messages(customer, threadId);
  expect(first.messages).toHaveLength(50);
  expect(first.nextCursor).not.toBeNull();
  const second = await threads.messages(customer, threadId, first.nextCursor!);
  expect(second.messages).toHaveLength(2);
  expect(new Set([...first.messages, ...second.messages].map((message) => message.id)).size).toBe(
    52,
  );
});

test('a ready run becomes a generic assistant notification', async () => {
  const threadId = await newThread();
  const jobs = new AgentJobs(
    db.db,
    redis,
    'test:agent:worker',
    async (_job, _text, _signal, emit) => {
      emit({
        event: 'message.delta',
        data: { text: 'Synthetic private reply that must not be notified.' },
      });
    },
    authorize,
  );
  const pipeline = new PostgresNotificationPipeline(
    db.db,
    {} as PushPort,
    {} as EmailPort,
    undefined,
    new ConfigService(db.db),
  );
  await jobs.start();
  try {
    const job = await jobs.submitMessage({
      userId: customer,
      threadId,
      clientMessageId: uuidV7(),
      text: 'Find milk',
      locale: 'en',
    });
    await waitForState(jobs, threadId, 'completed');
    const event = await sql<{
      id: string;
    }>`SELECT id FROM outbox_events WHERE aggregate_id=${job.id}::uuid AND event_type='AGENT_RUN_READY'`.execute(
      db.db,
    );
    await db.db.transaction().execute(async (tx) => {
      const rows = await sql<{
        id: string;
        event_type: string;
        schema_version: number;
        aggregate_type: string;
        aggregate_id: string;
        aggregate_version: string;
        occurred_at: Date;
        correlation_id: string;
        causation_id: string | null;
        payload: import('../../../src/platform/database/database.js').Json;
      }>`SELECT id,event_type,schema_version,aggregate_type,aggregate_id,aggregate_version::text AS aggregate_version,occurred_at,correlation_id,causation_id,payload FROM outbox_events WHERE id=${event.rows[0]!.id}::uuid`.execute(
        tx,
      );
      const row = rows.rows[0]!;
      await pipeline.consume(tx, {
        eventId: row.id,
        eventType: row.event_type,
        schemaVersion: row.schema_version,
        aggregateType: row.aggregate_type,
        aggregateId: row.aggregate_id,
        aggregateVersion: row.aggregate_version,
        occurredAt: row.occurred_at.toISOString(),
        correlationId: row.correlation_id,
        causationId: row.causation_id,
        payload: row.payload,
      });
    });
    const notes = await sql<{
      template_key: string;
      category: string;
      payload: unknown;
    }>`SELECT template_key,category,payload FROM notifications WHERE user_id=${customer}::uuid AND template_key='agent.reply_ready'`.execute(
      db.db,
    );
    expect(notes.rows).toHaveLength(1);
    expect(notes.rows[0]).toMatchObject({
      template_key: 'agent.reply_ready',
      category: 'ASSISTANT_UPDATES',
    });
    expect(JSON.stringify(notes.rows[0]?.payload)).not.toContain('Synthetic private reply');
    expect(JSON.stringify(notes.rows[0]?.payload)).not.toContain('Find milk');
  } finally {
    await jobs.stop();
  }
}, 30000);
