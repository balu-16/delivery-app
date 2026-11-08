import { resolve } from 'node:path';
import { runner } from 'node-pg-migrate';
import { sql } from 'kysely';
import { Client } from 'pg';
import { uuidV7 } from '../../../src/common/ids/ids.js';
import { createDatabase, type DatabaseHandle } from '../../../src/platform/database/database.js';
import { PostgresCouponRedemptions } from '../../../src/modules/coupons/infrastructure/postgres-redemptions.js';
import { PostgresFirstOrderCheck } from '../../../src/modules/coupons/infrastructure/first-order-check.js';
import { startTestServices, type TestServices } from '../../helpers/services.js';
let services: TestServices;
let db: DatabaseHandle;
const users: string[] = [];
beforeAll(async () => {
  services = await startTestServices();
  await runner({
    databaseUrl: services.databaseUrl,
    dir: resolve('db/migrations'),
    direction: 'up',
    migrationsTable: 'pgmigrations',
    log: () => undefined,
  });
  db = createDatabase(services.databaseUrl, 40);
  for (let index = 0; index < 6; index++) {
    const id = uuidV7();
    await sql`INSERT INTO users(id,pool,cognito_sub,normalized_email,name) VALUES(${id}::uuid,'CUSTOMER',${'conc-' + index},${'conc-' + index + '@example.invalid'},'customer')`.execute(
      db.db,
    );
    await sql`INSERT INTO user_roles(user_id,role) VALUES(${id}::uuid,'CUSTOMER')`.execute(db.db);
    users.push(id);
  }
}, 120000);
afterAll(async () => {
  await db?.close();
  await services?.stop();
}, 120000);
const redemptions = () => new PostgresCouponRedemptions(db.db, new PostgresFirstOrderCheck(db.db));
const reserve = (code: string, userId: string) =>
  db.db.transaction().execute((tx) => redemptions().reserve(code, userId, tx));
async function coupon(code: string, perUserLimit: number | null, globalLimit: number | null) {
  await sql`INSERT INTO coupons(id,code,kind,value,min_order_paise,per_user_limit,global_limit,created_by)
    VALUES(${uuidV7()}::uuid,${code},'FLAT','500','0',${perUserLimit},${globalLimit},${users[0]}::uuid)`.execute(
    db.db,
  );
}
async function couponState(code: string) {
  const result = await sql<{
    redeemed: string;
    reserved: string;
    committed: string;
    released: string;
  }>`SELECT c.redeemed_count::text AS redeemed,
    (SELECT COALESCE(sum(q.reserved_count),0)::text FROM coupon_user_quota q WHERE q.coupon_id=c.id) AS reserved,
    (SELECT COALESCE(sum(q.committed_count),0)::text FROM coupon_user_quota q WHERE q.coupon_id=c.id) AS committed,
    (SELECT count(*)::text FROM coupon_redemptions r WHERE r.coupon_id=c.id AND r.state='RELEASED') AS released
    FROM coupons c WHERE c.code=${code}`.execute(db.db);
  return result.rows[0]!;
}
/**
 * Real contention barrier: hold the coupon row on an independent transaction,
 * let every attempt pile up behind it, then release them simultaneously.
 */
async function underContention(
  code: string,
  factories: Array<() => Promise<string>>,
): Promise<PromiseSettledResult<string>[]> {
  let unlock!: () => void;
  let locked!: () => void;
  const gate = new Promise<void>((resolveGate) => {
    unlock = resolveGate;
  });
  const acquired = new Promise<void>((resolveAcquired) => {
    locked = resolveAcquired;
  });
  const blocker = db.db.transaction().execute(async (tx) => {
    await sql`SELECT 1 FROM coupons WHERE code=${code} FOR UPDATE`.execute(tx);
    locked();
    await gate;
  });
  await acquired;
  const started = factories.map((factory) => factory());
  const observer = new Client({ connectionString: services.databaseUrl });
  await observer.connect();
  const deadline = Date.now() + 5000;
  let waiting = 0;
  while (Date.now() < deadline) {
    const q = await observer.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'",
    );
    waiting = q.rows[0]!.n;
    if (waiting >= 2) break;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
  }
  await observer.end();
  unlock();
  await blocker;
  expect(waiting).toBeGreaterThanOrEqual(2);
  return Promise.allSettled(started);
}
it('50 parallel attempts for a 10-use coupon reserve exactly ten across users and devices', async () => {
  await coupon('CONC10', null, 10);
  // Ten rounds across five users plus two extra same-user devices: 52 racing
  // attempts against ten uses, each on its own connection and transaction.
  const attempts: Array<() => Promise<string>> = [];
  for (let round = 0; round < 10; round++)
    for (const userId of users.slice(0, 5)) attempts.push(() => reserve('CONC10', userId));
  attempts.push(
    () => reserve('CONC10', users[0]!),
    () => reserve('CONC10', users[0]!),
  );
  const outcomes = await underContention('CONC10', attempts);
  const fulfilled = outcomes.filter((o) => o.status === 'fulfilled');
  const rejected = outcomes.filter((o) => o.status === 'rejected');
  expect(fulfilled).toHaveLength(10);
  expect(rejected).toHaveLength(42);
  expect(
    rejected.every((o) => (o as PromiseRejectedResult).reason.message === 'COUPON_EXHAUSTED'),
  ).toBe(true);
  expect(new Set(fulfilled.map((o) => (o as PromiseFulfilledResult<string>).value)).size).toBe(10);
  expect(await couponState('CONC10')).toEqual({
    redeemed: '10',
    reserved: '10',
    committed: '0',
    released: '0',
  });
  const perUser = await sql<{ reserved: string }>`SELECT q.reserved_count::text AS reserved
    FROM coupon_user_quota q JOIN coupons c ON c.id=q.coupon_id WHERE c.code='CONC10'`.execute(
    db.db,
  );
  expect(perUser.rows.reduce((sum, row) => sum + Number(row.reserved), 0)).toBe(10);
}, 30000);
it('per-user limits hold under a same-user device storm', async () => {
  await coupon('CONCUSER', 3, 100);
  const attempts = Array.from({ length: 20 }, () => () => reserve('CONCUSER', users[5]!));
  const outcomes = await underContention('CONCUSER', attempts);
  const fulfilled = outcomes.filter((o) => o.status === 'fulfilled');
  const rejected = outcomes.filter((o) => o.status === 'rejected');
  expect(fulfilled).toHaveLength(3);
  expect(
    rejected.every((o) => (o as PromiseRejectedResult).reason.message === 'COUPON_LIMIT_REACHED'),
  ).toBe(true);
  expect(await couponState('CONCUSER')).toEqual({
    redeemed: '3',
    reserved: '3',
    committed: '0',
    released: '0',
  });
}, 30000);
it('releases restore quota exactly once and admit exactly the released count again', async () => {
  await coupon('CONCREL', null, 5);
  const reserved: string[] = [];
  for (let index = 0; index < 5; index++)
    reserved.push(await reserve('CONCREL', users[index % 5]!));
  expect(await couponState('CONCREL')).toEqual({
    redeemed: '5',
    reserved: '5',
    committed: '0',
    released: '0',
  });
  // Release two reservations, twice each: release is idempotent per state.
  for (const reservationId of [reserved[0]!, reserved[1]!])
    await db.db.transaction().execute(async (tx) => {
      await redemptions().release(reservationId, tx);
      await redemptions().release(reservationId, tx);
    });
  expect(await couponState('CONCREL')).toEqual({
    redeemed: '3',
    reserved: '3',
    committed: '0',
    released: '2',
  });
  const retry = Array.from({ length: 10 }, () => () => reserve('CONCREL', users[5]!));
  const outcomes = await underContention('CONCREL', retry);
  expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(2);
  expect(outcomes.filter((o) => o.status === 'rejected')).toHaveLength(8);
  expect(await couponState('CONCREL')).toEqual({
    redeemed: '5',
    reserved: '5',
    committed: '0',
    released: '2',
  });
}, 30000);
