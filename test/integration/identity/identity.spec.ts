import { resolve } from 'node:path';
import { runner } from 'node-pg-migrate';
import { sql } from 'kysely';
import { uuidV7 } from '../../../src/common/ids/ids.js';
import { LocalTokenAdapter } from '../../../src/adapters/auth/local.js';
import { createDatabase, type DatabaseHandle } from '../../../src/platform/database/database.js';
import { DatabaseIdentityAccess } from '../../../src/modules/identity/infrastructure/identity-access.js';
import { IdentityService } from '../../../src/modules/identity/infrastructure/identity-service.js';
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
}, 120_000);
afterAll(async () => {
  await db?.close();
  await services?.stop();
}, 120_000);

test('same email in separate pools remains distinct and stale workforce token cannot retain revoked role', async () => {
  const customer = uuidV7();
  const staff = uuidV7();
  await sql`INSERT INTO users(id,pool,cognito_sub,normalized_email,name,email_verified) VALUES
    (${customer}::uuid,'CUSTOMER','test-customer','same@example.test','Customer',true),
    (${staff}::uuid,'WORKFORCE','test-staff','same@example.test','Staff',true)`.execute(db.db);
  await sql`INSERT INTO user_roles(user_id,role) VALUES (${customer}::uuid,'CUSTOMER'),(${staff}::uuid,'STORE_MANAGER')`.execute(
    db.db,
  );
  const adapter = new LocalTokenAdapter('test-secret-for-local-identity', db.db);
  const token = await adapter.issue('WORKFORCE', 'test-staff', 'store', 'access');
  const verified = await adapter.verify(token, 'store', 'access');
  const service = new IdentityService(db.db, new DatabaseIdentityAccess(db.db));
  expect((await service.authorize(verified, 'store')).userId).toBe(staff);
  await expect(adapter.verify(token, 'admin', 'access')).rejects.toThrow();
  await expect(adapter.verify(token, 'store', 'id')).rejects.toThrow();
  await sql`DELETE FROM user_roles WHERE user_id=${staff}::uuid AND role='STORE_MANAGER'`.execute(
    db.db,
  );
  await expect(service.authorize(verified, 'store')).rejects.toThrow('FORBIDDEN');
  const found = await sql<{
    n: string;
  }>`SELECT count(*)::text AS n FROM users WHERE normalized_email='same@example.test'`.execute(
    db.db,
  );
  expect(found.rows[0]?.n).toBe('2');
});

test('bootstrap is idempotent for the same verified pool and subject, and rejects blocked users', async () => {
  const service = new IdentityService(db.db, new DatabaseIdentityAccess(db.db));
  const identity = {
    pool: 'CUSTOMER' as const,
    sub: 'new-customer',
    tokenUse: 'id' as const,
    groups: [],
    email: 'new@example.test',
    emailVerified: true,
    name: 'New User',
    expiresAt: 9999999999,
  };
  const first = await service.bootstrap(identity);
  const second = await service.bootstrap(identity);
  expect(first.userId).toBe(second.userId);
  await sql`UPDATE users SET status='BLOCKED' WHERE id=${first.userId}::uuid`.execute(db.db);
  await expect(service.bootstrap(identity)).rejects.toThrow('ACCOUNT_DISABLED');
});

test('unverified email may bootstrap but remains unverified for checkout policy', async () => {
  const service = new IdentityService(db.db, new DatabaseIdentityAccess(db.db));
  const principal = await service.bootstrap({
    pool: 'CUSTOMER',
    sub: 'unverified',
    tokenUse: 'id',
    groups: [],
    email: 'pending@example.test',
    emailVerified: false,
    expiresAt: 9999999999,
  });
  expect(principal.emailVerified).toBe(false);
});

test('workforce creation recovers a lost provider response without duplicate users', async () => {
  const { LocalIdentityAdmin } = await import('../../../src/adapters/auth/local-admin.js');
  const { WorkforceProvisioning } =
    await import('../../../src/modules/identity/infrastructure/workforce-provisioning.js');
  const adminId = uuidV7();
  await sql`INSERT INTO users(id,pool,cognito_sub,normalized_email,name) VALUES (${adminId}::uuid,'WORKFORCE','provision-admin','provision-admin@example.test','Admin')`.execute(
    db.db,
  );
  await sql`INSERT INTO user_roles(user_id,role) VALUES (${adminId}::uuid,'ADMIN')`.execute(db.db);
  const directory = new LocalIdentityAdmin(db.db);
  let loseResponse = true;
  const faulty = {
    async create(username: string, email: string, name: string) {
      const created = await directory.create(username, email, name);
      if (loseResponse) {
        loseResponse = false;
        throw new Error('timeout after provider success');
      }
      return created;
    },
    find: directory.find.bind(directory),
    addToGroup: directory.addToGroup.bind(directory),
    removeFromGroup: directory.removeFromGroup.bind(directory),
    enable: directory.enable.bind(directory),
    delete: directory.delete.bind(directory),
    disable: directory.disable.bind(directory),
    forcePasswordReset: directory.forcePasswordReset.bind(directory),
  };
  const provision = new WorkforceProvisioning(db.db, faulty);
  const result = await Promise.all(
    Array.from({ length: 5 }, () =>
      provision.provision(adminId, 'new-rider@example.test', 'Rider', 'RIDER'),
    ),
  );
  expect(new Set(result.map((value) => value.userId)).size).toBe(1);
  const counts = await sql<{ directory: string; local: string }>`SELECT
    (SELECT count(*)::text FROM local_identity_directory WHERE email='new-rider@example.test') AS directory,
    (SELECT count(*)::text FROM users WHERE normalized_email='new-rider@example.test') AS local`.execute(
    db.db,
  );
  expect(counts.rows[0]).toEqual({ directory: '1', local: '1' });
});

test('identity provider synchronization survives failures and preserves per-user operation order', async () => {
  const { IdentitySyncWorker } =
    await import('../../../src/modules/identity/infrastructure/identity-sync-worker.js');
  const { LocalIdentityAdmin } = await import('../../../src/adapters/auth/local-admin.js');
  const id = uuidV7();
  const username = 'sync-user';
  await sql`INSERT INTO users(id,pool,cognito_sub,normalized_email,name) VALUES (${id}::uuid,'WORKFORCE',${username},'sync-user@example.test','Sync')`.execute(
    db.db,
  );
  await sql`INSERT INTO local_identity_directory(pool,username,sub,email,name) VALUES ('WORKFORCE',${username},${username},'sync-user@example.test','Sync')`.execute(
    db.db,
  );
  const first = uuidV7(),
    second = uuidV7();
  await sql`INSERT INTO identity_sync_operations(id,user_id,action,details) VALUES (${first}::uuid,${id}::uuid,'ROLE_GRANTED','{"role":"RIDER","grant":true}'::jsonb),(${second}::uuid,${id}::uuid,'ROLE_REMOVED','{"role":"RIDER","grant":false}'::jsonb)`.execute(
    db.db,
  );
  const local = new LocalIdentityAdmin(db.db);
  let fail = true;
  const faulty = {
    create: local.create.bind(local),
    find: local.find.bind(local),
    delete: local.delete.bind(local),
    disable: local.disable.bind(local),
    enable: local.enable.bind(local),
    removeFromGroup: local.removeFromGroup.bind(local),
    forcePasswordReset: local.forcePasswordReset.bind(local),
    addToGroup: async (
      name: string,
      role: import('../../../src/modules/identity/contracts/identity.js').Role,
    ) => {
      if (fail) {
        fail = false;
        throw new Error('temporary');
      }
      await local.addToGroup(name, role);
    },
  };
  const worker = new IdentitySyncWorker(db.db, { WORKFORCE: faulty, CUSTOMER: local });
  expect(await worker.runOne()).toBe(true);
  expect(await worker.runOne()).toBe(false);
  await sql`UPDATE identity_sync_operations SET next_attempt_at=clock_timestamp() WHERE id=${first}::uuid`.execute(
    db.db,
  );
  expect(await worker.runOne()).toBe(true);
  expect(await worker.runOne()).toBe(true);
  const result = await sql<{
    state: string;
  }>`SELECT state FROM identity_sync_operations WHERE id=ANY(${[first, second]}::uuid[]) ORDER BY seq`.execute(
    db.db,
  );
  expect(result.rows.map((row) => row.state)).toEqual(['COMPLETE', 'COMPLETE']);
  const groups = await sql<{
    n: string;
  }>`SELECT count(*)::text AS n FROM local_identity_groups WHERE username=${username}`.execute(
    db.db,
  );
  expect(groups.rows[0]?.n).toBe('0');
});

test('failed local provisioning leaves recoverable compensation and retries deletion before recreation', async () => {
  const { LocalIdentityAdmin } = await import('../../../src/adapters/auth/local-admin.js');
  const { WorkforceProvisioning } =
    await import('../../../src/modules/identity/infrastructure/workforce-provisioning.js');
  const actor = uuidV7(),
    conflict = uuidV7();
  await sql`INSERT INTO users(id,pool,cognito_sub,normalized_email,name) VALUES (${actor}::uuid,'WORKFORCE','saga-recovery-admin','saga-recovery-admin@test.invalid','Admin'),(${conflict}::uuid,'WORKFORCE','existing-conflict','saga-conflict@test.invalid','Conflict')`.execute(
    db.db,
  );
  await sql`INSERT INTO user_roles(user_id,role) VALUES (${actor}::uuid,'ADMIN')`.execute(db.db);
  const local = new LocalIdentityAdmin(db.db);
  let failDelete = true;
  const provider = {
    create: local.create.bind(local),
    find: local.find.bind(local),
    addToGroup: local.addToGroup.bind(local),
    removeFromGroup: local.removeFromGroup.bind(local),
    enable: local.enable.bind(local),
    disable: local.disable.bind(local),
    forcePasswordReset: local.forcePasswordReset.bind(local),
    delete: async (name: string) => {
      if (failDelete) {
        failDelete = false;
        throw new Error('temporary');
      }
      await local.delete(name);
    },
  };
  const saga = new WorkforceProvisioning(db.db, provider);
  await expect(
    saga.provision(actor, 'saga-conflict@test.invalid', 'New Rider', 'RIDER'),
  ).rejects.toThrow();
  const pending = await sql<{
    state: string;
  }>`SELECT state FROM identity_provisioning WHERE normalized_email='saga-conflict@test.invalid'`.execute(
    db.db,
  );
  expect(pending.rows[0]?.state).toBe('COMPENSATION_REQUIRED');
  const { IdentitySyncWorker } =
    await import('../../../src/modules/identity/infrastructure/identity-sync-worker.js');
  const worker = new IdentitySyncWorker(db.db, { CUSTOMER: local, WORKFORCE: provider });
  expect(await worker.compensateOne()).toBe(true);
  const recovered = await sql<{
    state: string;
  }>`SELECT state FROM identity_provisioning WHERE normalized_email='saga-conflict@test.invalid'`.execute(
    db.db,
  );
  expect(recovered.rows[0]?.state).toBe('REQUESTED');
  await sql`DELETE FROM users WHERE id=${conflict}::uuid`.execute(db.db);
  const result = await saga.provision(actor, 'saga-conflict@test.invalid', 'New Rider', 'RIDER');
  const state = await sql<{
    state: string;
  }>`SELECT state FROM identity_provisioning WHERE id=${result.operationId}::uuid`.execute(db.db);
  expect(state.rows[0]?.state).toBe('COMPLETE');
});

test('rider review serializes concurrent approvals and accepts profile after documents', async () => {
  const { RiderOnboarding } =
    await import('../../../src/modules/identity/infrastructure/rider-onboarding.js');
  const { RiderProfileService } =
    await import('../../../src/modules/identity/infrastructure/rider-profile.js');
  const rider = uuidV7(),
    reviewer = uuidV7();
  await sql`INSERT INTO users(id,pool,cognito_sub,normalized_email,name) VALUES (${rider}::uuid,'WORKFORCE','review-rider','review-rider@test.invalid','Rider'),(${reviewer}::uuid,'WORKFORCE','review-admin','review-admin@test.invalid','Admin')`.execute(
    db.db,
  );
  await sql`INSERT INTO user_roles(user_id,role) VALUES (${rider}::uuid,'RIDER'),(${reviewer}::uuid,'ADMIN')`.execute(
    db.db,
  );
  await sql`INSERT INTO rider_profiles(user_id,status) VALUES (${rider}::uuid,'PENDING')`.execute(
    db.db,
  );
  const { ConfigService } =
    await import('../../../src/modules/app-config/infrastructure/config-service.js');
  const config = new ConfigService(db.db);
  const uploads = {
    createTarget: async () => ({ mediaId: '', url: '', fields: {} }),
    assertOwnedRegistered: async () => undefined,
    signedRead: async () => '',
  };
  const onboarding = new RiderOnboarding(db.db, uploads, config);
  for (const type of ['licence', 'vehicle_rc', 'id_proof', 'bank_proof'])
    await onboarding.registerDocument(rider, type, uuidV7());
  const pending = await sql<{
    status: string;
  }>`SELECT status FROM rider_profiles WHERE user_id=${rider}::uuid`.execute(db.db);
  expect(pending.rows[0]?.status).toBe('PENDING');
  await new RiderProfileService(db.db, config).profile(rider, 'bike', 'ABC');
  const documents = await sql<{
    id: string;
  }>`SELECT id FROM rider_documents WHERE rider_id=${rider}::uuid`.execute(db.db);
  await Promise.all(documents.rows.map(({ id }) => onboarding.review(reviewer, id, true, '')));
  const approved = await sql<{
    status: string;
  }>`SELECT status FROM rider_profiles WHERE user_id=${rider}::uuid`.execute(db.db);
  expect(approved.rows[0]?.status).toBe('APPROVED');
});

test('store role revocation removes assignments and password reset is queued for the correct pool', async () => {
  const { IdentityAdminService } =
    await import('../../../src/modules/identity/infrastructure/admin-service.js');
  const { IdentitySyncWorker } =
    await import('../../../src/modules/identity/infrastructure/identity-sync-worker.js');
  const { LocalIdentityAdmin } = await import('../../../src/adapters/auth/local-admin.js');
  const actor = uuidV7(),
    staff = uuidV7(),
    store = uuidV7(),
    city = uuidV7(),
    entity = uuidV7();
  await sql`INSERT INTO users(id,pool,cognito_sub,normalized_email,name) VALUES (${actor}::uuid,'WORKFORCE','assign-admin','assign-admin@test.invalid','Admin'),(${staff}::uuid,'WORKFORCE','assign-staff','assign-staff@test.invalid','Staff')`.execute(
    db.db,
  );
  await sql`INSERT INTO user_roles(user_id,role) VALUES (${actor}::uuid,'SUPER_ADMIN'),(${staff}::uuid,'PICKER')`.execute(
    db.db,
  );
  await sql`INSERT INTO legal_entities(id,name) VALUES (${entity}::uuid,'Entity')`.execute(db.db);
  await sql`INSERT INTO cities(id,name,bounds) VALUES (${city}::uuid,'City',ST_GeomFromText('POLYGON((0 0,1 0,1 1,0 1,0 0))',4326))`.execute(
    db.db,
  );
  await sql`INSERT INTO stores(id,legal_entity_id,city_id,name,location,status,hourly_capacity) VALUES (${store}::uuid,${entity}::uuid,${city}::uuid,'Store',ST_GeogFromText('POINT(0.5 0.5)'),'ONLINE',100)`.execute(
    db.db,
  );
  const admin = new IdentityAdminService(db.db);
  await admin.setStoreAssignment(actor, staff, store, 'PICKER', true);
  expect(await new DatabaseIdentityAccess(db.db).hasStoreRole(staff, store, ['PICKER'])).toBe(true);
  await db.db
    .transaction()
    .execute((tx) => admin.setRoleInTransaction(tx, actor, staff, 'PICKER', false));
  await db.db
    .transaction()
    .execute((tx) => admin.setRoleInTransaction(tx, actor, staff, 'PICKER', true));
  expect(await new DatabaseIdentityAccess(db.db).hasStoreRole(staff, store, ['PICKER'])).toBe(
    false,
  );
  expect((await admin.listUsers(actor, 'assign-staff')).users.map((user) => user.userId)).toEqual([
    staff,
  ]);
  await admin.resetPassword(actor, staff);
  const queued = await sql<{
    action: string;
  }>`SELECT action FROM identity_sync_operations WHERE user_id=${staff}::uuid ORDER BY seq`.execute(
    db.db,
  );
  expect(queued.rows.map((row) => row.action)).toEqual([
    'ROLE_REMOVED',
    'ROLE_GRANTED',
    'PASSWORD_RESET_REQUESTED',
  ]);
  const local = new LocalIdentityAdmin(db.db);
  let reset = '';
  const workforce = {
    create: local.create.bind(local),
    find: local.find.bind(local),
    delete: local.delete.bind(local),
    disable: local.disable.bind(local),
    enable: local.enable.bind(local),
    addToGroup: async () => {},
    removeFromGroup: async () => {},
    forcePasswordReset: async (username: string) => {
      reset = username;
    },
  };
  const worker = new IdentitySyncWorker(db.db, { CUSTOMER: local, WORKFORCE: workforce });
  for (let i = 0; i < 3; i++) expect(await worker.runOne()).toBe(true);
  expect(reset).toBe('assign-staff');
});

test('consent and erasure requests write one audit event across retries', async () => {
  const { DatabaseUserProfiles } =
    await import('../../../src/modules/identity/infrastructure/user-profiles.js');
  const userId = uuidV7();
  await sql`INSERT INTO users(id,pool,cognito_sub,normalized_email,name) VALUES (${userId}::uuid,'CUSTOMER','audit-customer','audit-customer@test.invalid','Customer')`.execute(
    db.db,
  );
  const service = new IdentityService(db.db, new DatabaseIdentityAccess(db.db));
  await Promise.all([
    service.acceptConsent(userId, 'terms', '1', null),
    service.acceptConsent(userId, 'terms', '1', null),
  ]);
  const profiles = new DatabaseUserProfiles(db.db);
  const requests = await Promise.all([
    profiles.requestErasure(userId),
    profiles.requestErasure(userId),
  ]);
  expect(requests[0]).toBe(requests[1]);
  const audit = await sql<{
    action: string;
    n: string;
  }>`SELECT action,count(*)::text AS n FROM audit_log WHERE actor_id=${userId}::uuid GROUP BY action ORDER BY action`.execute(
    db.db,
  );
  expect(audit.rows).toEqual([
    { action: 'CONSENT_ACCEPTED', n: '1' },
    { action: 'ERASURE_REQUESTED', n: '1' },
  ]);
});
