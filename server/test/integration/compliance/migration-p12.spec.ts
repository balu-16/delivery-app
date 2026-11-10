import { resolve } from 'node:path';
import { runner } from 'node-pg-migrate';
import { sql } from 'kysely';
import { uuidV7 } from '../../../src/common/ids/ids.js';
import { createDatabase, type DatabaseHandle } from '../../../src/platform/database/database.js';
import { startTestServices, type TestServices } from '../../helpers/services.js';
let services: TestServices;
let db: DatabaseHandle;
beforeAll(async () => {
  services = await startTestServices();
  await runner({
    databaseUrl: services.databaseUrl,
    dir: resolve('db/migrations'),
    migrationsTable: 'pgmigrations',
    direction: 'up',
    count: 27,
    log: () => undefined,
  });
  db = createDatabase(services.databaseUrl);
}, 120000);
afterAll(async () => {
  await db?.close();
  await services?.stop();
}, 120000);
test('populated P10–P12 migration round trip retains existing identity and erasure data', async () => {
  const user = uuidV7(),
    request = uuidV7(),
    job = uuidV7();
  await sql`INSERT INTO users(id,pool,cognito_sub,normalized_email,name) VALUES (${user}::uuid,'CUSTOMER',${user},${`${user}@test.example`},'Customer')`.execute(
    db.db,
  );
  await sql`INSERT INTO erasure_requests(id,user_id,status) VALUES (${request}::uuid,${user}::uuid,'CLEANUP')`.execute(
    db.db,
  );
  await sql`INSERT INTO compliance_export_jobs(id,owner_id,audience,kind,request_key,request_hash,status) VALUES (${job}::uuid,${user}::uuid,'CUSTOMER','personal','key','hash','QUEUED')`.execute(
    db.db,
  );
  const options = {
    databaseUrl: services.databaseUrl,
    dir: resolve('db/migrations'),
    migrationsTable: 'pgmigrations',
    log: () => undefined,
  };
  await runner({ ...options, direction: 'down', count: 3 });
  const prior = await sql<{
    status: string;
  }>`SELECT status FROM erasure_requests WHERE id=${request}::uuid`.execute(db.db);
  expect(prior.rows[0]?.status).toBe('BLOCKED');
  await runner({ ...options, direction: 'up' });
  const after = await sql<{
    status: string;
  }>`SELECT status FROM erasure_requests WHERE id=${request}::uuid`.execute(db.db);
  expect(after.rows[0]?.status).toBe('BLOCKED');
  expect((await sql`SELECT id FROM users WHERE id=${user}::uuid`.execute(db.db)).rows).toHaveLength(
    1,
  );
});
