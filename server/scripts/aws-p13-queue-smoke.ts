import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { sql } from 'kysely';
import { createDatabase, postgresConnectionConfig } from '../src/platform/database/database.js';
import { SqsConcernStore } from '../src/platform/queue/sqs-concern-store.js';

/** Real Aurora concurrency test in an isolated, short-lived logical database. */
async function main() {
  if (process.env.AWS_P13_ISOLATED_DATABASE !== 'yes')
    throw new Error('Set AWS_P13_ISOLATED_DATABASE=yes to create a temporary test database');
  if (process.env.NODE_ENV !== 'development' || process.env.DATABASE_AUTH !== 'iam')
    throw new Error('A development IAM database configuration is required');
  const region = process.env.AWS_REGION;
  const ownerUrl = process.env.MIGRATION_DATABASE_URL;
  const runtimeUrl = process.env.DATABASE_URL;
  if (!region || !ownerUrl || !runtimeUrl) throw new Error('Missing database configuration');
  const owner = new URL(ownerUrl);
  const runtime = new URL(runtimeUrl);
  if (
    owner.hostname !== runtime.hostname ||
    owner.port !== runtime.port ||
    owner.pathname !== '/deliveryapp'
  )
    throw new Error('Owner and development database endpoints must match');

  const name = `delivery_p13_${randomUUID().replaceAll('-', '')}`;
  const admin = new Pool({
    ...postgresConnectionConfig(ownerUrl, region),
    max: 1,
    connectionTimeoutMillis: 30000,
  });
  let created = false;
  let database: ReturnType<typeof createDatabase> | undefined;
  let locker: Pool | undefined;
  try {
    const identity = await admin.query<{
      current_user: string;
      current_database: string;
      rolcreatedb: boolean;
    }>(
      'SELECT current_user, current_database(), (SELECT rolcreatedb FROM pg_roles WHERE rolname=current_user) AS rolcreatedb',
    );
    if (identity.rows[0]?.current_database !== 'deliveryapp' || !identity.rows[0]?.rolcreatedb)
      throw new Error('The owner must have CREATE DATABASE on the development cluster');
    await admin.query(`CREATE DATABASE "${name}"`);
    created = true;
    owner.pathname = `/${name}`;
    const testUrl = owner.toString();
    database = createDatabase(testUrl, 4, 30000, () => undefined, 30000, region);
    const migration = await readFile('db/migrations/031_sqs_concern_jobs.sql', 'utf8');
    const [up, down] = migration.split('-- Down Migration');
    if (!up || !down) throw new Error('Migration 031 sections are missing');
    await sql.raw(up).execute(database.db);
    const store = new SqsConcernStore(database.db);
    const id = await store.enqueue('payments', 'payment', { test: true }, randomUUID());
    const send = (await store.claimDue()).find((item) => item.pointer.jobId === id);
    assert.ok(send);
    await store.sent(send);

    locker = new Pool({
      ...postgresConnectionConfig(testUrl, region),
      max: 1,
      connectionTimeoutMillis: 30000,
    });
    const client = await locker.connect();
    let lockHeld = false;
    let attempts: Promise<Awaited<ReturnType<SqsConcernStore['acquire']>>[]> | undefined;
    try {
      await client.query('BEGIN');
      lockHeld = true;
      await client.query('SELECT 1 FROM sqs_concern_jobs WHERE concern=$1 AND id=$2 FOR UPDATE', [
        'payments',
        id,
      ]);
      attempts = Promise.all([
        store.acquire('payments', send.pointer),
        store.acquire('payments', send.pointer),
      ]);
      let blocked = false;
      const deadline = Date.now() + 30000;
      while (Date.now() < deadline) {
        const waiting = await admin.query<{ count: string }>(
          "SELECT count(*)::text AS count FROM pg_stat_activity WHERE datname=$1 AND wait_event_type='Lock'",
          [name],
        );
        if (Number(waiting.rows[0]?.count) >= 2) {
          blocked = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      assert.ok(blocked, 'Both independent claim requests must be blocked by the held row lock');
      await client.query('COMMIT');
      lockHeld = false;
      const claims = await attempts;
      assert.deepEqual(claims.map((claim) => claim.kind).sort(), ['busy', 'claimed']);
      const claimed = claims.find((claim) => claim.kind === 'claimed');
      if (!claimed || claimed.kind !== 'claimed') throw new Error('Missing claimed job');
      assert.equal(await store.finish('payments', send.pointer, claimed.job.token), true);
      assert.equal((await store.acquire('payments', send.pointer)).kind, 'terminal');
      console.log('Aurora concurrent SQS job lease, exclusion, completion and replay: passed');
    } finally {
      if (lockHeld) await client.query('ROLLBACK').catch(() => undefined);
      client.release();
      if (attempts) await attempts.catch(() => undefined);
    }
  } finally {
    let cleanupError: unknown;
    try {
      await locker?.end();
    } catch (error) {
      cleanupError = error;
    }
    try {
      await database?.close();
    } catch (error) {
      cleanupError ??= error;
    }
    try {
      if (created) {
        await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
        console.log('Temporary Aurora test database removed');
      }
    } finally {
      await admin.end();
    }
    if (cleanupError) {
      console.error('A test connection could not be closed cleanly');
      process.exitCode = 1;
    }
  }
}

void main().catch((error: unknown) => {
  console.error(
    'AWS isolated P13 queue test failed:',
    error instanceof Error ? error.message : 'unknown error',
  );
  process.exitCode = 1;
});
