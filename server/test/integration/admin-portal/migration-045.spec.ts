import { resolve } from 'node:path';
import { runner } from 'node-pg-migrate';
import { sql } from 'kysely';
import { createDatabase } from '../../../src/platform/database/database.js';
import { startTestServices, type TestServices } from '../../helpers/services.js';

let services: TestServices;
let db: ReturnType<typeof createDatabase>;

beforeAll(async () => {
  services = await startTestServices();
  await runner({
    databaseUrl: services.databaseUrl,
    dir: resolve('db/migrations'),
    direction: 'up',
    migrationsTable: 'pgmigrations',
    log: () => undefined,
  });
  db = createDatabase(services.databaseUrl);
}, 120_000);
afterAll(async () => {
  await db?.close();
  await services?.stop();
}, 120_000);

it('applies migration 045 with the documented session columns and indexes', async () => {
  const columns = await sql<{
    column_name: string;
    data_type: string;
    is_nullable: string;
  }>`SELECT column_name,data_type,is_nullable
    FROM information_schema.columns
    WHERE table_schema='public' AND table_name='admin_sessions'
    ORDER BY column_name`.execute(db.db);
  const names = columns.rows.map((row) => row.column_name).sort();
  expect(names).toEqual([
    'absolute_expires_at',
    'created_at',
    'csrf_token_hash',
    'id',
    'idle_expires_at',
    'last_seen_at',
    'provider',
    'revoked_at',
    'rotated_from',
    'tokens',
    'user_id',
  ]);
  const tokens = columns.rows.find((row) => row.column_name === 'tokens');
  expect(tokens?.data_type).toBe('bytea');
  const indexes = await sql<{ indexname: string }>`SELECT indexname FROM pg_indexes
    WHERE schemaname='public' AND tablename='admin_sessions' ORDER BY indexname`.execute(db.db);
  expect(indexes.rows.map((row) => row.indexname)).toContain('admin_sessions_user_idx');
  expect(indexes.rows.map((row) => row.indexname)).toContain('admin_sessions_active_idle_idx');
  const directory = await sql<{ is_nullable: string }>`SELECT is_nullable
    FROM information_schema.columns
    WHERE table_name='local_identity_directory' AND column_name='password_hash'`.execute(db.db);
  expect(directory.rows[0]?.is_nullable).toBe('YES');
});

it('rejects down migrations for the forward-only admin session table', async () => {
  const alreadyApplied = await sql<{
    n: string;
  }>`SELECT COUNT(*)::text AS n FROM pgmigrations WHERE name LIKE '045%'`.execute(db.db);
  expect(alreadyApplied.rows[0]?.n).toBe('1');
});
