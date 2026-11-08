import { resolve } from 'node:path';
import { runner } from 'node-pg-migrate';
import { sql } from 'kysely';
import { uuidV7 } from '../../../src/common/ids/ids.js';
import { SharedWorkforceProvisioning } from '../../../src/modules/identity/infrastructure/shared-workforce-provisioning.js';
import type { IdentityAdminPort } from '../../../src/modules/identity/contracts/identity.js';
import { createDatabase, type DatabaseHandle } from '../../../src/platform/database/database.js';
import { startTestServices, type TestServices } from '../../helpers/services.js';

let services: TestServices;
let db: DatabaseHandle;
let actor: string;
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
  actor = uuidV7();
  await sql`INSERT INTO users(id,pool,cognito_sub,normalized_email,name) VALUES (${actor}::uuid,'WORKFORCE','admin-sub','actor@example.test','Actor')`.execute(
    db.db,
  );
  await sql`INSERT INTO user_roles(user_id,role) VALUES (${actor}::uuid,'ADMIN')`.execute(db.db);
}, 120000);
afterAll(async () => {
  await db?.close();
  await services?.stop();
}, 120000);

test('existing customer identity is left untouched and not adopted as workforce', async () => {
  const calls: string[] = [];
  const provider = {
    find: async () => ({ sub: 'existing-customer' }),
    create: async () => {
      calls.push('create');
      return { sub: 'other' };
    },
    addToGroup: async () => {
      calls.push('add');
    },
    delete: async () => {
      calls.push('delete');
    },
  } as unknown as IdentityAdminPort;
  await expect(
    new SharedWorkforceProvisioning(db.db, provider).provision(
      actor,
      'existing@example.test',
      'Existing',
      'RIDER',
    ),
  ).rejects.toThrow('EXISTING_COGNITO_IDENTITY_REQUIRES_REVIEW');
  expect(calls).toEqual([]);
  const found = await sql<{
    n: string;
  }>`SELECT count(*)::text AS n FROM users WHERE pool='WORKFORCE' AND cognito_sub='existing-customer'`.execute(
    db.db,
  );
  expect(found.rows[0]?.n).toBe('0');
});

test('new workforce identity is created once and replay does not restore revoked roles', async () => {
  const calls: string[] = [];
  const provider = {
    find: async () => null,
    create: async () => {
      calls.push('create');
      return { sub: 'new-sub' };
    },
    addToGroup: async () => {
      calls.push('add');
    },
  } as unknown as IdentityAdminPort;
  const service = new SharedWorkforceProvisioning(db.db, provider);
  const created = await service.provision(actor, 'new@example.test', 'New', 'RIDER');
  await sql`DELETE FROM user_roles WHERE user_id=${created.userId}::uuid AND role='RIDER'`.execute(
    db.db,
  );
  expect(await service.provision(actor, 'new@example.test', 'New', 'RIDER')).toEqual(created);
  const found = await sql<{
    n: string;
  }>`SELECT count(*)::text AS n FROM user_roles WHERE user_id=${created.userId}::uuid AND role='RIDER'`.execute(
    db.db,
  );
  expect(found.rows[0]?.n).toBe('0');
  expect(calls).toEqual(['create', 'add']);
});

test('ambiguous create is not adopted, changed, or deleted on retry', async () => {
  let exists = false;
  const calls: string[] = [];
  const provider = {
    find: async () => (exists ? { sub: 'uncertain-sub' } : null),
    create: async () => {
      exists = true;
      calls.push('create');
      throw new Error('timeout');
    },
    addToGroup: async () => {
      calls.push('add');
    },
    delete: async () => {
      calls.push('delete');
    },
  } as unknown as IdentityAdminPort;
  const service = new SharedWorkforceProvisioning(db.db, provider);
  await expect(
    service.provision(actor, 'uncertain@example.test', 'Uncertain', 'RIDER'),
  ).rejects.toThrow('timeout');
  await expect(
    service.provision(actor, 'uncertain@example.test', 'Uncertain', 'RIDER'),
  ).rejects.toThrow('EXISTING_COGNITO_IDENTITY_REQUIRES_REVIEW');
  expect(calls).toEqual(['create']);
});
