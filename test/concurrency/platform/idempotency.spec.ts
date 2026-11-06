import { resolve } from 'node:path';
import { sql } from 'kysely';
import { runner } from 'node-pg-migrate';
import { IdempotencyStore, hashRequest } from '../../../src/common/idempotency/idempotency.js';
import { createDatabase, type DatabaseHandle } from '../../../src/platform/database/database.js';
import { startTestServices, type TestServices } from '../../helpers/services.js';

let services: TestServices;
let db: DatabaseHandle;
beforeAll(async () => {
  services = await startTestServices();
  await runner({
    databaseUrl: services.databaseUrl,
    dir: resolve('db/migrations'),
    direction: 'up',
    migrationsTable: 'pgmigrations',
  });
  db = createDatabase(services.databaseUrl);
  await sql`CREATE TABLE test_effects(operation_id uuid PRIMARY KEY)`.execute(db.db);
}, 120000);
afterAll(async () => {
  await db?.close();
  await services?.stop();
}, 120000);

it('serializes same-key claims and permanently fences the operation after response pruning', async () => {
  const store = new IdempotencyStore(db.db);
  const scope = {
    actor: 'actor',
    audience: 'customer',
    method: 'POST',
    resource: '/orders',
    key: 'same-key',
  };
  const hash = hashRequest('{}');
  const claims = await Promise.all(Array.from({ length: 12 }, () => store.claim(scope, hash)));
  const owners = claims.filter((claim) => claim.kind === 'claimed');
  expect(owners).toHaveLength(1);
  const owner = owners[0];
  if (!owner || owner.kind !== 'claimed') throw new Error('Claim missing');
  await store.execute(owner.owner, async (tx, operationId) => {
    await sql`INSERT INTO test_effects(operation_id) VALUES (${operationId}::uuid)`.execute(tx);
    return { status: 201, body: { operationId } };
  });
  expect((await store.claim(scope, hash)).kind).toBe('replay');
  await sql`UPDATE idempotency_keys SET response_expires_at=clock_timestamp()-interval '1 second' WHERE key='same-key'`.execute(
    db.db,
  );
  await store.pruneResponses();
  expect(await store.claim(scope, hash)).toEqual({
    kind: 'response_expired',
    operationId: owner.owner.operationId,
  });
  expect((await store.claim(scope, hashRequest('{"changed":true}'))).kind).toBe('key_reused');
  const result = await sql<{
    count: string;
  }>`SELECT count(*)::text AS count FROM test_effects`.execute(db.db);
  expect(result.rows[0]?.count).toBe('1');
});

it('does not steal an expired lease while a mutation holds the row lock', async () => {
  const store = new IdempotencyStore(db.db);
  const scope = {
    actor: 'actor',
    audience: 'customer',
    method: 'POST',
    resource: '/orders',
    key: 'live-owner',
  };
  const hash = hashRequest('{}');
  const claim = await store.claim(scope, hash);
  if (claim.kind !== 'claimed') throw new Error('Claim missing');
  let locked!: () => void;
  let release!: () => void;
  const lockHeld = new Promise<void>((resolve) => {
    locked = resolve;
  });
  const proceed = new Promise<void>((resolve) => {
    release = resolve;
  });
  const execute = store.execute(claim.owner, async (tx, operationId) => {
    await sql`UPDATE idempotency_keys SET lease_until=clock_timestamp()-interval '1 second' WHERE key='live-owner'`.execute(
      tx,
    );
    locked();
    await proceed;
    await sql`INSERT INTO test_effects(operation_id) VALUES (${operationId}::uuid)`.execute(tx);
    return { status: 201, body: { operationId } };
  });
  await lockHeld;
  let competingClaim: ReturnType<typeof store.claim> | undefined;
  try {
    await expect(
      sql`SELECT key FROM idempotency_keys WHERE key='live-owner' FOR UPDATE NOWAIT`.execute(db.db),
    ).rejects.toMatchObject({ code: '55P03' });
    competingClaim = store.claim(scope, hash);
  } finally {
    release();
  }
  await execute;
  expect((await competingClaim!).kind).toBe('replay');
});
