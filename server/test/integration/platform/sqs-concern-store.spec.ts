import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { sql } from 'kysely';
import { runner } from 'node-pg-migrate';
import { createDatabase, type DatabaseHandle } from '../../../src/platform/database/database.js';
import { SqsConcernStore } from '../../../src/platform/queue/sqs-concern-store.js';
import { startTestServices, type TestServices } from '../../helpers/services.js';

let services: TestServices;
let database: DatabaseHandle;
let store: SqsConcernStore;

beforeAll(async () => {
  services = await startTestServices();
  await runner({
    databaseUrl: services.databaseUrl,
    dir: resolve('db/migrations'),
    migrationsTable: 'pgmigrations',
    direction: 'up',
    log: () => undefined,
  });
  database = createDatabase(services.databaseUrl, 4);
  store = new SqsConcernStore(database.db);
}, 120000);

afterAll(async () => {
  await database?.close();
  await services?.stop();
}, 120000);

test('publishing does not delay the first claim; completed operations can be re-enqueued safely', async () => {
  const operation = randomUUID();
  const id = await store.enqueue('payments', 'payment', { id: operation }, operation);
  const send = (await store.claimDue()).find((entry) => entry.pointer.jobId === id);
  expect(send).toBeDefined();
  await store.sent(send!);
  const pointer = send!.pointer;
  const claims = await Promise.all([
    store.acquire('payments', pointer),
    store.acquire('payments', pointer),
  ]);
  expect(claims.map((claim) => claim.kind).sort()).toEqual(['busy', 'claimed']);
  const claimed = claims.find((claim) => claim.kind === 'claimed');
  if (!claimed || claimed.kind !== 'claimed') throw new Error('missing claim');
  expect(await store.finish('payments', pointer, claimed.job.token)).toBe(true);
  await store.enqueue('payments', 'payment', { id: operation }, operation);
  expect((await store.acquire('payments', pointer)).kind).toBe('terminal');
  const next = await store.acquire('payments', { ...pointer, generation: 2 });
  expect(next.kind).toBe('claimed');
});

test('failed jobs replay with a new generation and stale pointers cannot claim them', async () => {
  const id = await store.enqueue('imports', 'import', {}, randomUUID());
  const pointer = { version: 1 as const, jobId: id, generation: 1 };
  for (let attempt = 0; attempt < 2; attempt++) {
    const claim = await store.acquire('imports', pointer);
    if (claim.kind !== 'claimed') throw new Error('missing claim');
    expect(await store.fail('imports', pointer, claim.job.token, 2)).toBe(true);
    await sql`UPDATE sqs_concern_jobs SET available_at=clock_timestamp() WHERE concern='imports' AND id=${id}`.execute(
      database.db,
    );
  }
  expect(await store.getFailed('imports', id)).toMatchObject({ id, attempts: 2 });
  await store.replay('imports', id);
  expect((await store.acquire('imports', pointer)).kind).toBe('terminal');
  expect((await store.acquire('imports', { ...pointer, generation: 2 })).kind).toBe('claimed');
});

test('concurrent scheduler ticks create one durable job for a due occurrence', async () => {
  const schedulerId = randomUUID();
  await store.upsertScheduler('dispatch', schedulerId, 'scan', {}, { everyMs: 60000 });
  await sql`UPDATE sqs_concern_schedules SET next_run_at=clock_timestamp()-interval '1 second' WHERE concern='dispatch' AND scheduler_id=${schedulerId}`.execute(
    database.db,
  );
  const ticks = await Promise.all([store.tickSchedules(), store.tickSchedules()]);
  expect(ticks.reduce((a, b) => a + b, 0)).toBe(1);
  const rows = await sql<{
    count: number;
  }>`SELECT count(*)::int AS count FROM sqs_concern_jobs WHERE concern='dispatch' AND name='scan'`.execute(
    database.db,
  );
  expect(rows.rows[0]?.count).toBe(1);
});

test('repeated worker crashes eventually mark an expired job failed', async () => {
  const id = await store.enqueue('notifications', 'deliver', {}, randomUUID());
  const pointer = { version: 1 as const, jobId: id, generation: 1 };
  for (let attempt = 0; attempt < 5; attempt++) {
    expect((await store.acquire('notifications', pointer)).kind).toBe('claimed');
    await sql`UPDATE sqs_concern_jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE concern='notifications' AND id=${id}`.execute(
      database.db,
    );
  }
  expect((await store.acquire('notifications', pointer)).kind).toBe('failed');
  expect(await store.getFailed('notifications', id)).toMatchObject({ attempts: 5 });
});
