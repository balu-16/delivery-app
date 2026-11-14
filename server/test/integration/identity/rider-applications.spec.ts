import { resolve } from 'node:path';
import { runner } from 'node-pg-migrate';
import { sql } from 'kysely';
import { uuidV7 } from '../../../src/common/ids/ids.js';
import { LocalIdentityAdmin } from '../../../src/adapters/auth/local-admin.js';
import { createDatabase, type DatabaseHandle } from '../../../src/platform/database/database.js';
import { ConfigService } from '../../../src/modules/app-config/infrastructure/config-service.js';
import { DatabaseIdentityAccess } from '../../../src/modules/identity/infrastructure/identity-access.js';
import { IdentityService } from '../../../src/modules/identity/infrastructure/identity-service.js';
import { IdentitySyncWorker } from '../../../src/modules/identity/infrastructure/identity-sync-worker.js';
import { PostgresRiderApplications } from '../../../src/modules/identity/infrastructure/rider-applications.js';
import { RiderOnboarding } from '../../../src/modules/identity/infrastructure/rider-onboarding.js';
import { RiderProfileService } from '../../../src/modules/identity/infrastructure/rider-profile.js';
import { MakerChecker } from '../../../src/modules/compliance/infrastructure/maker-checker.js';
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

test('verified applications converge, sync a pending rider role, and require all document approvals', async () => {
  const sub = uuidV7(),
    reviewer = uuidV7(),
    outsider = uuidV7(),
    entity = uuidV7(),
    city = uuidV7(),
    store = uuidV7(),
    otherStore = uuidV7();
  const identity = {
    pool: 'WORKFORCE' as const,
    tokenUse: 'id' as const,
    sub,
    email: `${sub}@example.test`,
    name: 'Rider',
    emailVerified: true,
    groups: [],
    expiresAt: 9999999999,
  };
  await sql`INSERT INTO local_identity_directory(pool,username,sub,email,name,email_verified)
    VALUES('WORKFORCE',${sub},${sub},${identity.email},'Rider',true)`.execute(db.db);
  await sql`INSERT INTO users(id,pool,cognito_sub,normalized_email,name) VALUES
    (${reviewer}::uuid,'WORKFORCE',${reviewer},${`${reviewer}@example.test`},'Manager'),
    (${outsider}::uuid,'WORKFORCE',${outsider},${`${outsider}@example.test`},'Other manager')`.execute(
    db.db,
  );
  await sql`INSERT INTO user_roles(user_id,role) VALUES(${reviewer}::uuid,'STORE_MANAGER'),(${outsider}::uuid,'STORE_MANAGER')`.execute(
    db.db,
  );
  await sql`INSERT INTO legal_entities(id,name) VALUES(${entity}::uuid,'Entity')`.execute(db.db);
  await sql`INSERT INTO cities(id,name,bounds) VALUES(${city}::uuid,'City',ST_GeomFromText('POLYGON((0 0,1 0,1 1,0 1,0 0))',4326))`.execute(
    db.db,
  );
  await sql`INSERT INTO stores(id,legal_entity_id,city_id,name,location,status,hourly_capacity) VALUES
    (${store}::uuid,${entity}::uuid,${city}::uuid,'Store',ST_GeogFromText('POINT(0.5 0.5)'),'ONLINE',100),
    (${otherStore}::uuid,${entity}::uuid,${city}::uuid,'Other store',ST_GeogFromText('POINT(0.5 0.5)'),'ONLINE',100)`.execute(
    db.db,
  );
  await sql`INSERT INTO store_staff(user_id,store_id,role) VALUES
    (${reviewer}::uuid,${store}::uuid,'STORE_MANAGER'),(${outsider}::uuid,${otherStore}::uuid,'STORE_MANAGER')`.execute(
    db.db,
  );
  const config = new ConfigService(db.db);
  const applications = new PostgresRiderApplications(db.db, config);
  const submitted = await Promise.all(
    Array.from({ length: 5 }, () => applications.bootstrap(identity)),
  );
  expect(new Set(submitted.map((entry) => entry.userId)).size).toBe(1);
  expect(submitted.every((entry) => entry.status === 'PENDING' && entry.groupPending)).toBe(true);
  const rider = submitted[0]!.userId;
  const service = new IdentityService(db.db, new DatabaseIdentityAccess(db.db));
  const access = { ...identity, tokenUse: 'access' as const, groups: ['RIDER'] };
  await expect(service.authorize(access, 'rider')).rejects.toThrow('RIDER_NOT_APPROVED');

  const provider = new LocalIdentityAdmin(db.db);
  const sync = new IdentitySyncWorker(db.db, { CUSTOMER: provider, WORKFORCE: provider });
  expect(await sync.runOne()).toBe(true);
  expect((await applications.bootstrap({ ...identity, groups: ['RIDER'] })).groupPending).toBe(
    false,
  );
  const group =
    await sql`SELECT 1 FROM local_identity_groups WHERE pool='WORKFORCE' AND username=${sub} AND role='RIDER'`.execute(
      db.db,
    );
  expect(group.rows).toHaveLength(1);
  await sql`DELETE FROM local_identity_groups WHERE pool='WORKFORCE' AND username=${sub} AND role='RIDER'`.execute(
    db.db,
  );
  const retry = await Promise.all(
    Array.from({ length: 5 }, () => applications.bootstrap(identity)),
  );
  expect(retry.every((item) => item.groupPending)).toBe(true);
  const pending = await sql<{
    count: string;
  }>`SELECT count(*)::text AS count FROM identity_sync_operations
    WHERE user_id=${rider}::uuid AND action='ROLE_GRANTED' AND state<>'COMPLETE'`.execute(db.db);
  expect(pending.rows[0]?.count).toBe('1');
  expect(await sync.runOne()).toBe(true);
  expect((await applications.bootstrap({ ...identity, groups: ['RIDER'] })).groupPending).toBe(
    false,
  );

  const uploads = {
    createTarget: async () => ({ mediaId: '', url: '', fields: {} }),
    assertOwnedRegistered: async () => undefined,
    signedRead: async () => '',
  };
  const onboarding = new RiderOnboarding(db.db, uploads, config);
  await new RiderProfileService(db.db, config).profile(rider, 'bike', 'KA01ABC');
  for (const type of ['licence', 'vehicle_rc', 'id_proof', 'bank_proof'])
    await onboarding.registerDocument(rider, type, uuidV7());
  expect((await applications.get(rider)).status).toBe('PENDING');
  await applications.selectStore(rider, store);
  const application = await applications.get(rider);
  expect(application.status).toBe('UNDER_REVIEW');
  expect(application.homeStoreId).toBe(store);
  await expect(applications.getForStore(outsider, rider)).rejects.toThrow('FORBIDDEN');
  await expect(onboarding.review(outsider, application.documents[0]!.id, true, '')).rejects.toThrow(
    'FORBIDDEN',
  );
  expect(
    (await applications.listForStore(reviewer, store, undefined, 'UNDER_REVIEW')).items.some(
      (entry) => entry.userId === rider,
    ),
  ).toBe(true);
  await expect(applications.selectStore(rider, otherStore)).rejects.toThrow('RIDER_STATE_INVALID');
  await onboarding.review(reviewer, application.documents[0]!.id, true, '');
  expect((await applications.get(rider)).status).toBe('UNDER_REVIEW');
  await onboarding.review(
    reviewer,
    application.documents[1]!.id,
    false,
    'Please upload a clearer image',
  );
  expect((await applications.get(rider)).status).toBe('REJECTED');
  await applications.selectStore(rider, otherStore);
  const moved = await applications.get(rider);
  expect(
    moved.documents.find((document) => document.type === application.documents[0]!.type)?.status,
  ).toBe('PENDING');
  await expect(applications.getForStore(reviewer, rider)).rejects.toThrow('FORBIDDEN');
  expect((await applications.getForStore(outsider, rider)).homeStoreId).toBe(otherStore);
  await onboarding.registerDocument(rider, application.documents[1]!.type, uuidV7());
  const resubmitted = await applications.get(rider);
  expect(resubmitted.status).toBe('UNDER_REVIEW');
  for (const document of resubmitted.documents.filter((item) => item.status === 'PENDING'))
    await onboarding.review(outsider, document.id, true, '');
  expect((await applications.get(rider)).status).toBe('APPROVED');
  expect((await service.authorize(access, 'rider')).userId).toBe(rider);
  expect(
    (await applications.listForStore(outsider, otherStore, undefined, 'APPROVED')).items.some(
      (entry) => entry.userId === rider,
    ),
  ).toBe(true);
  await sql`UPDATE users SET status='BLOCKED' WHERE id=${rider}::uuid`.execute(db.db);
  await expect(applications.getForStore(outsider, rider)).rejects.toThrow('FORBIDDEN');
  await sql`UPDATE users SET status='ACTIVE' WHERE id=${rider}::uuid`.execute(db.db);
  await sql`UPDATE user_roles SET role='SUPPORT_AGENT' WHERE user_id=${rider}::uuid`.execute(db.db);
  await expect(applications.getForStore(outsider, rider)).rejects.toThrow('FORBIDDEN');
});

test('bootstrap rejects unverified email, blocked identities and workforce email conflicts', async () => {
  const applications = new PostgresRiderApplications(db.db, new ConfigService(db.db));
  const sub = uuidV7();
  const identity = {
    pool: 'WORKFORCE' as const,
    tokenUse: 'id' as const,
    sub,
    email: `${sub}@example.test`,
    emailVerified: false,
    groups: [],
    expiresAt: 9999999999,
  };
  await expect(applications.bootstrap(identity)).rejects.toThrow('EMAIL_NOT_VERIFIED');
  const first = await applications.bootstrap({ ...identity, emailVerified: true });
  await sql`UPDATE users SET status='BLOCKED' WHERE id=${first.userId}::uuid`.execute(db.db);
  await expect(applications.bootstrap({ ...identity, emailVerified: true })).rejects.toThrow(
    'ACCOUNT_DISABLED',
  );
  await expect(
    applications.bootstrap({ ...identity, sub: uuidV7(), emailVerified: true }),
  ).rejects.toThrow('RIDER_ENROLLMENT_REQUIRES_REVIEW');
});

test('concurrent customer and rider enrollment cannot create two roles for one subject', async () => {
  const sub = uuidV7();
  const base = {
    sub,
    tokenUse: 'id' as const,
    email: `${sub}@example.test`,
    emailVerified: true,
    groups: [],
    expiresAt: 9999999999,
  };
  const customer = new IdentityService(db.db, new DatabaseIdentityAccess(db.db));
  const rider = new PostgresRiderApplications(db.db, new ConfigService(db.db));
  const results = await Promise.allSettled([
    customer.bootstrap({ ...base, pool: 'CUSTOMER' }),
    rider.bootstrap({ ...base, pool: 'WORKFORCE' }),
  ]);
  expect(results.filter((item) => item.status === 'fulfilled')).toHaveLength(1);
  expect(results.filter((item) => item.status === 'rejected')).toHaveLength(1);
  const rows = await sql`SELECT pool FROM users WHERE cognito_sub=${sub}`.execute(db.db);
  expect(rows.rows).toHaveLength(1);
});

test('one administrator can approve an action once, but support cannot approve its own request', async () => {
  const admin = uuidV7(),
    support = uuidV7();
  await sql`INSERT INTO users(id,pool,cognito_sub,normalized_email,name) VALUES
    (${admin}::uuid,'WORKFORCE',${admin},${`${admin}@example.test`},'Admin'),
    (${support}::uuid,'WORKFORCE',${support},${`${support}@example.test`},'Support')`.execute(
    db.db,
  );
  await sql`INSERT INTO user_roles(user_id,role) VALUES(${admin}::uuid,'SUPER_ADMIN'),(${support}::uuid,'SUPPORT_AGENT')`.execute(
    db.db,
  );
  let executions = 0;
  const action = {
    version: 1,
    makerRole: 'SUPER_ADMIN',
    checkerRole: 'SUPER_ADMIN',
    ttlSeconds: 300,
    validate: () => true,
    execute: async () => {
      executions++;
    },
  };
  const approvals = new MakerChecker(db.db, {
    admin: action,
    support: { ...action, makerRole: 'SUPPORT_AGENT' },
  });
  const id = await approvals.request(admin, 'admin', {});
  await approvals.approve(admin, id);
  await expect(approvals.approve(admin, id)).rejects.toThrow('APPROVAL_INVALID');
  expect(executions).toBe(1);
  const audit = await sql<{
    single: boolean;
  }>`SELECT (details->>'singlePerson')::boolean AS single FROM audit_log
    WHERE action='APPROVAL_EXECUTED' AND subject_id=${id}`.execute(db.db);
  expect(audit.rows[0]?.single).toBe(true);
  const supportId = await approvals.request(support, 'support', {});
  await expect(approvals.approve(support, supportId)).rejects.toThrow('APPROVAL_INVALID');
});
