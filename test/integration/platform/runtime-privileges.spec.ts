import { randomBytes, randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { createDatabase } from '../../../src/platform/database/database.js';
import { WalletPrimitives } from '../../../src/modules/wallet/infrastructure/postgres-wallet.js';
import { WalletCreditService } from '../../../src/modules/wallet/infrastructure/postgres-credits.js';
import { PostgresTrackingPrivacy } from '../../../src/modules/tracking/infrastructure/privacy.js';
import type { RedisRiderGeo } from '../../../src/modules/tracking/infrastructure/redis-geo.js';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { Client } from 'pg';
import { runner } from 'node-pg-migrate';
import { startTestServices, type TestServices } from '../../helpers/services.js';

const exec = promisify(execFile);
let services: TestServices;
let admin: Client;
const role = `runtime_${randomBytes(8).toString('hex')}`;
beforeAll(async () => {
  services = await startTestServices();
  await runner({
    databaseUrl: services.databaseUrl,
    dir: resolve('db/migrations'),
    direction: 'up',
    migrationsTable: 'pgmigrations',
  });
  admin = new Client({ connectionString: services.databaseUrl });
  await admin.connect();
  await admin.query(
    `CREATE ROLE ${role} NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`,
  );
  await admin.query(`GRANT TRUNCATE, REFERENCES, TRIGGER ON TABLE audit_log TO ${role}`);
  await exec(process.execPath, ['--import', 'tsx', 'scripts/grant-runtime.ts'], {
    env: {
      ...process.env,
      MIGRATION_DATABASE_URL: services.databaseUrl,
      RUNTIME_DATABASE_ROLE: role,
    },
  });
}, 120000);
afterAll(async () => {
  if (admin) {
    await admin.query('RESET ROLE');
    await admin.query(`DROP OWNED BY ${role}`);
    await admin.query(`DROP ROLE ${role}`);
    await admin.end();
  }
  await services?.stop();
}, 120000);
it('allows application DML and bounded partition maintenance while denying DDL and history deletion', async () => {
  await admin.query(`SET ROLE ${role}`);
  const flags = await admin.query(
    `SELECT rolsuper,rolcreatedb,rolcreaterole FROM pg_roles WHERE rolname=current_user`,
  );
  expect(flags.rows[0]).toEqual({ rolsuper: false, rolcreatedb: false, rolcreaterole: false });
  await expect(admin.query('CREATE TABLE public.runtime_should_fail(id int)')).rejects.toThrow();
  await expect(admin.query('CREATE TEMP TABLE runtime_temp_should_fail(id int)')).rejects.toThrow();
  await expect(admin.query('DELETE FROM audit_log')).rejects.toThrow();
  await expect(
    admin.query('UPDATE public.spatial_ref_sys SET srtext=srtext WHERE false'),
  ).rejects.toThrow();
  await expect(
    admin.query(
      "INSERT INTO public.spatial_ref_sys(srid,auth_name,auth_srid,srtext,proj4text) VALUES (998999,'test',998999,'test','test')",
    ),
  ).rejects.toThrow();
  await expect(admin.query('TRUNCATE audit_log')).rejects.toThrow();
  const grants = await admin.query(
    "SELECT has_table_privilege(current_user,'public.audit_log','REFERENCES') AS refs, has_table_privilege(current_user,'public.audit_log','TRIGGER') AS trigger",
  );
  expect(grants.rows[0]).toEqual({ refs: false, trigger: false });
  await expect(admin.query('SELECT * FROM pgmigrations')).rejects.toThrow();
  await admin.query(
    `INSERT INTO durable_operations(id,kind,reference,state,payload) VALUES (gen_random_uuid(),'test','test','PENDING','{}')`,
  );
  await admin.query(
    `SELECT public.ensure_location_partitions((clock_timestamp() AT TIME ZONE 'UTC')::date + 2)`,
  );
  await admin.query(
    `SELECT public.ensure_location_partition((clock_timestamp() AT TIME ZONE 'UTC')::date)`,
  );
  await expect(
    admin.query(
      `SELECT public.ensure_location_partition((clock_timestamp() AT TIME ZONE 'UTC')::date + 3)`,
    ),
  ).rejects.toThrow();
  await expect(
    admin.query(
      `SELECT public.drop_location_partition((clock_timestamp() AT TIME ZONE 'UTC')::date)`,
    ),
  ).rejects.toThrow();
  await admin.query('RESET ROLE');
});

it('enforces the current retention policy and supports safe replay', async () => {
  await admin.query(
    `INSERT INTO app_config(key,value) VALUES ('locationRetentionDays','1') ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value`,
  );
  await admin.query(`SET ROLE ${role}`);
  try {
    await admin.query(
      `SELECT public.ensure_location_partition((clock_timestamp() AT TIME ZONE 'UTC')::date - 5)`,
    );
    await expect(
      admin.query(
        `SELECT public.drop_location_partition((clock_timestamp() AT TIME ZONE 'UTC')::date - 2)`,
      ),
    ).rejects.toThrow();
    await admin.query(
      `SELECT public.drop_location_partition((clock_timestamp() AT TIME ZONE 'UTC')::date - 5)`,
    );
    await admin.query(
      `SELECT public.drop_location_partition((clock_timestamp() AT TIME ZONE 'UTC')::date - 5)`,
    );
  } finally {
    await admin.query('RESET ROLE');
  }
});

it('executes an idempotent wallet credit as the runtime role', async () => {
  const user = randomUUID();
  await admin.query(
    `INSERT INTO users(id,pool,cognito_sub,normalized_email,name) VALUES ($1::uuid,'CUSTOMER',$1::text,$2,'Runtime test')`,
    [user, `${user}@example.test`],
  );
  const handle = createDatabase(services.databaseUrl, 1);
  try {
    await sql.raw(`SET ROLE ${role}`).execute(handle.db);
    const wallet = new WalletCreditService(new WalletPrimitives(handle.db));
    const credit = {
      userId: user,
      bucket: 'cash' as const,
      amountPaise: '100',
      reason: 'TOPUP_CREDIT' as const,
      refType: 'TEST',
      refId: randomUUID(),
    };
    expect(await wallet.credit(credit)).toBe(true);
    expect(await wallet.credit(credit)).toBe(false);
    const result = await sql<{
      balance: string;
      entries: string;
    }>`SELECT a.cash_balance_paise::text AS balance, (SELECT count(*)::text FROM wallet_ledger l WHERE l.account_id=a.id) AS entries FROM wallet_accounts a WHERE a.user_id=${user}::uuid`.execute(
      handle.db,
    );
    expect(result.rows[0]).toEqual({ balance: '100', entries: '1' });
    await expect(sql`DELETE FROM wallet_ledger`.execute(handle.db)).rejects.toThrow();
  } finally {
    await handle.close();
  }
});

it('rejects inherited public CREATE on another schema and preserves existing grants on rollback', async () => {
  await admin.query('CREATE SCHEMA runtime_unsafe');
  await admin.query('GRANT CREATE ON SCHEMA runtime_unsafe TO PUBLIC');
  try {
    await expect(
      exec(process.execPath, ['--import', 'tsx', 'scripts/grant-runtime.ts'], {
        env: {
          ...process.env,
          MIGRATION_DATABASE_URL: services.databaseUrl,
          RUNTIME_DATABASE_ROLE: role,
        },
      }),
    ).rejects.toThrow();
    const result = await admin.query(
      "SELECT has_table_privilege($1,'public.durable_operations','INSERT') AS allowed",
      [role],
    );
    expect(result.rows[0]?.allowed).toBe(true);
  } finally {
    await admin.query('REVOKE CREATE ON SCHEMA runtime_unsafe FROM PUBLIC');
    await admin.query('DROP SCHEMA runtime_unsafe');
  }
});

it('fences rider location and erases history in batches under the runtime role', async () => {
  const rider = randomUUID();
  await admin.query(
    `INSERT INTO users(id,pool,cognito_sub,normalized_email,name) VALUES ($1::uuid,'WORKFORCE',$1::text,$2,'Runtime rider')`,
    [rider, `${rider}@example.test`],
  );
  await admin.query(
    `SELECT public.ensure_location_partition((clock_timestamp() AT TIME ZONE 'UTC')::date)`,
  );
  await admin.query(
    `INSERT INTO rider_status(rider_id,last_location,last_location_at,last_location_source) VALUES ($1::uuid, ST_SetSRID(ST_MakePoint(77,12),4326)::geography,clock_timestamp(),'GPS')`,
    [rider],
  );
  await admin.query(
    `INSERT INTO rider_location_history(rider_id,ts,location) SELECT $1::uuid, date_trunc('day', clock_timestamp() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' + x * interval '1 second', ST_SetSRID(ST_MakePoint(77,12),4326)::geography FROM generate_series(1,3) x`,
    [rider],
  );
  const handle = createDatabase(services.databaseUrl, 1);
  let removals = 0;
  const geo = {
    removeMember: async () => {
      removals++;
    },
  } as unknown as RedisRiderGeo;
  try {
    await sql.raw(`SET ROLE ${role}`).execute(handle.db);
    const privacy = new PostgresTrackingPrivacy(handle.db, geo, 2);
    await handle.db.transaction().execute((tx) => privacy.fence(rider, tx));
    expect(await privacy.eraseBatch(rider)).toBe(false);
    expect(await privacy.eraseBatch(rider)).toBe(true);
    expect(removals).toBe(2);
    const result = await sql<{
      remaining: string;
      cleared: boolean;
    }>`SELECT (SELECT count(*)::text FROM rider_location_history WHERE rider_id=${rider}::uuid) AS remaining, (SELECT last_location IS NULL FROM rider_status WHERE rider_id=${rider}::uuid) AS cleared`.execute(
      handle.db,
    );
    expect(result.rows[0]).toEqual({ remaining: '0', cleared: true });
  } finally {
    await handle.close();
  }
});
