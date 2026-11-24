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
    createTarget: async () => ({ mediaId: '', url: '', fields: {}, expiresAt: '' }),
    prepareOwnedUpload: async () => ({ commit: async () => {}, release: async () => {} }),
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
  await sql`UPDATE rider_profiles SET vehicle_no=NULL WHERE user_id=${rider}::uuid`.execute(db.db);
  await expect(
    onboarding.review(reviewer, application.documents[0]!.id, true, '', { role: 'STORE_MANAGER' }),
  ).rejects.toThrow('DOCUMENT_STATE_INVALID');
  await sql`UPDATE rider_profiles SET vehicle_no='KA01ABC' WHERE user_id=${rider}::uuid`.execute(
    db.db,
  );
  await sql`UPDATE rider_profiles SET review_required_documents=array_append(review_required_documents,'missing-doc')
    WHERE user_id=${rider}::uuid`.execute(db.db);
  await expect(
    onboarding.review(reviewer, application.documents[0]!.id, true, '', { role: 'STORE_MANAGER' }),
  ).rejects.toThrow('DOCUMENT_STATE_INVALID');
  await sql`UPDATE rider_profiles SET review_required_documents=array_remove(review_required_documents,'missing-doc')
    WHERE user_id=${rider}::uuid`.execute(db.db);
  await expect(applications.getForStore(outsider, rider)).rejects.toThrow('FORBIDDEN');
  await expect(
    onboarding.review(outsider, application.documents[0]!.id, true, '', {
      role: 'STORE_MANAGER',
    }),
  ).rejects.toThrow('FORBIDDEN');
  expect(
    (await applications.listForStore(reviewer, store, undefined, 'UNDER_REVIEW')).items.some(
      (entry) => entry.userId === rider,
    ),
  ).toBe(true);
  await expect(applications.selectStore(rider, otherStore)).rejects.toThrow('RIDER_STATE_INVALID');
  await onboarding.review(reviewer, application.documents[0]!.id, true, '', {
    role: 'STORE_MANAGER',
  });
  expect((await applications.get(rider)).status).toBe('UNDER_REVIEW');
  await onboarding.review(
    reviewer,
    application.documents[1]!.id,
    false,
    'Please upload a clearer image',
    {
      role: 'STORE_MANAGER',
    },
  );
  const rejected = await applications.get(rider);
  expect(rejected.status).toBe('REJECTED');
  expect(
    rejected.documents.find((document) => document.id === application.documents[1]!.id)?.reason,
  ).toBe('Please upload a clearer image');
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
    await onboarding.review(outsider, document.id, true, '', { role: 'STORE_MANAGER' });
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
  await sql`UPDATE users SET normalized_email=${`archived-${first.userId}@example.invalid`}
    WHERE id=${first.userId}::uuid`.execute(db.db);
  const replacement = await applications.bootstrap({
    ...identity,
    sub: uuidV7(),
    emailVerified: true,
    groups: ['RIDER'],
  });
  expect(replacement.userId).not.toBe(first.userId);
  expect(await applications.get(replacement.userId)).toMatchObject({
    status: 'PENDING',
    homeStoreId: null,
    vehicleType: null,
    documents: [],
  });
});

test('a verified rider group starts a blank draft and repairs only its own rider profile', async () => {
  const applications = new PostgresRiderApplications(db.db, new ConfigService(db.db));
  const sub = uuidV7();
  const identity = {
    pool: 'WORKFORCE' as const,
    tokenUse: 'id' as const,
    sub,
    email: `${sub}@example.test`,
    emailVerified: true,
    groups: ['RIDER'],
    expiresAt: 9999999999,
  };
  const first = await applications.bootstrap(identity);
  expect(first).toMatchObject({ status: 'PENDING', groupPending: false });
  expect(await applications.get(first.userId)).toMatchObject({
    homeStoreId: null,
    vehicleType: null,
    vehicleNo: null,
    documents: [],
  });
  const sync =
    await sql`SELECT 1 FROM identity_sync_operations WHERE user_id=${first.userId}::uuid`.execute(
      db.db,
    );
  expect(sync.rows).toHaveLength(0);

  await sql`DELETE FROM rider_profiles WHERE user_id=${first.userId}::uuid`.execute(db.db);
  await expect(applications.bootstrap(identity)).resolves.toEqual(first);
  await sql`UPDATE user_roles SET role='SUPPORT_AGENT' WHERE user_id=${first.userId}::uuid`.execute(
    db.db,
  );
  await expect(applications.bootstrap(identity)).rejects.toThrow('ROLE_CONFLICT');
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

const REVIEW_DOC_TYPES = ['licence', 'vehicle_rc', 'id_proof', 'bank_proof'];

async function seedReviewUsers() {
  const admin = uuidV7(),
    manager = uuidV7(),
    outsider = uuidV7(),
    impostor = uuidV7(),
    entity = uuidV7(),
    city = uuidV7(),
    store = uuidV7(),
    otherStore = uuidV7();
  await sql`INSERT INTO users(id,pool,cognito_sub,normalized_email,name) VALUES
    (${admin}::uuid,'WORKFORCE',${admin},${`${admin}@example.test`},'Admin'),
    (${manager}::uuid,'WORKFORCE',${manager},${`${manager}@example.test`},'Manager'),
    (${outsider}::uuid,'WORKFORCE',${outsider},${`${outsider}@example.test`},'Outsider'),
    (${impostor}::uuid,'WORKFORCE',${impostor},${`${impostor}@example.test`},'Impostor')`.execute(
    db.db,
  );
  await sql`INSERT INTO user_roles(user_id,role) VALUES(${admin}::uuid,'SUPER_ADMIN'),(${manager}::uuid,'STORE_MANAGER'),(${outsider}::uuid,'STORE_MANAGER'),(${impostor}::uuid,'RIDER')`.execute(
    db.db,
  );
  await sql`INSERT INTO legal_entities(id,name) VALUES(${entity}::uuid,'Review entity')`.execute(
    db.db,
  );
  await sql`INSERT INTO cities(id,name,bounds) VALUES(${city}::uuid,'Review city',ST_GeomFromText('POLYGON((0 0,1 0,1 1,0 1,0 0))',4326))`.execute(
    db.db,
  );
  await sql`INSERT INTO stores(id,legal_entity_id,city_id,name,location,status,hourly_capacity) VALUES
    (${store}::uuid,${entity}::uuid,${city}::uuid,'Review store',ST_GeogFromText('POINT(0.5 0.5)'),'ONLINE',100),
    (${otherStore}::uuid,${entity}::uuid,${city}::uuid,'Other review store',ST_GeogFromText('POINT(0.5 0.5)'),'ONLINE',100)`.execute(
    db.db,
  );
  await sql`INSERT INTO store_staff(user_id,store_id,role) VALUES(${manager}::uuid,${store}::uuid,'STORE_MANAGER'),(${outsider}::uuid,${otherStore}::uuid,'STORE_MANAGER')`.execute(
    db.db,
  );
  return { admin, manager, outsider, impostor, store, otherStore };
}

async function bootstrapUnderReview(sub: string, store: string) {
  const identity = {
    pool: 'WORKFORCE' as const,
    tokenUse: 'id' as const,
    sub,
    email: `${sub}@example.test`,
    name: 'Review rider',
    emailVerified: true,
    groups: [],
    expiresAt: 9999999999,
  };
  await sql`INSERT INTO local_identity_directory(pool,username,sub,email,name,email_verified)
    VALUES('WORKFORCE',${sub},${sub},${identity.email},'Review rider',true)`.execute(db.db);
  const config = new ConfigService(db.db);
  const applications = new PostgresRiderApplications(db.db, config);
  const { userId: rider } = await applications.bootstrap(identity);
  const onboarding = new RiderOnboarding(
    db.db,
    {
      createTarget: async () => ({ mediaId: '', url: '', fields: {}, expiresAt: '' }),
      async prepareOwnedUpload() {
        return { commit: async () => undefined, release: async () => undefined };
      },
      assertOwnedRegistered: async () => undefined,
      signedRead: async () => 'https://signed.test/rider-doc/read',
    },
    config,
  );
  await new RiderProfileService(db.db, config).profile(rider, 'bike', 'KA01ABC');
  for (const type of REVIEW_DOC_TYPES) await onboarding.registerDocument(rider, type, uuidV7());
  await applications.selectStore(rider, store);
  return { rider, applications, onboarding, config };
}

test('admin and manager approve different documents on the same application and either can finish independently', async () => {
  const { admin, manager, outsider, impostor, store, otherStore } = await seedReviewUsers();
  const first = await bootstrapUnderReview(uuidV7(), store);
  const second = await bootstrapUnderReview(uuidV7(), otherStore);
  expect((await first.applications.get(first.rider)).status).toBe('UNDER_REVIEW');
  const snapshot = await sql<{
    status: string;
    review_required_documents: string[] | null;
  }>`SELECT status,review_required_documents FROM rider_profiles WHERE user_id=${first.rider}::uuid`.execute(
    db.db,
  );
  expect(snapshot.rows[0]).toEqual({
    status: 'UNDER_REVIEW',
    review_required_documents: REVIEW_DOC_TYPES,
  });
  const documents = (await first.applications.get(first.rider)).documents;
  expect(documents.map((doc) => doc.type).sort()).toEqual([...REVIEW_DOC_TYPES].sort());

  // Admin read-url works; outsider manager and non-admin are denied.
  await expect(
    first.onboarding.reviewUrl(admin, documents[0]!.id, { role: 'SUPER_ADMIN' }),
  ).resolves.toBe('https://signed.test/rider-doc/read');
  await expect(
    first.onboarding.reviewUrl(outsider, documents[0]!.id, { role: 'STORE_MANAGER' }),
  ).rejects.toThrow('FORBIDDEN');
  await expect(
    first.onboarding.reviewUrl(impostor, documents[0]!.id, { role: 'SUPER_ADMIN' }),
  ).rejects.toThrow('FORBIDDEN');
  // A reviewer cannot review their own application, even with admin scope.
  await sql`UPDATE user_roles SET role='SUPER_ADMIN' WHERE user_id=${first.rider}::uuid`.execute(
    db.db,
  );
  await expect(
    first.onboarding.review(first.rider, documents[0]!.id, true, '', { role: 'SUPER_ADMIN' }),
  ).rejects.toThrow('FORBIDDEN');
  await expect(
    first.onboarding.reviewUrl(first.rider, documents[0]!.id, { role: 'SUPER_ADMIN' }),
  ).rejects.toThrow('DOCUMENT_NOT_FOUND');
  await sql`UPDATE user_roles SET role='RIDER' WHERE user_id=${first.rider}::uuid`.execute(db.db);

  // Manager and admin approve different documents on the same application.
  await first.onboarding.review(manager, documents[0]!.id, true, '', { role: 'STORE_MANAGER' });
  await first.onboarding.review(admin, documents[1]!.id, true, '', { role: 'SUPER_ADMIN' });
  expect((await first.applications.get(first.rider)).status).toBe('UNDER_REVIEW');
  await first.onboarding.review(admin, documents[2]!.id, true, '', { role: 'SUPER_ADMIN' });
  await first.onboarding.review(manager, documents[3]!.id, true, '', { role: 'STORE_MANAGER' });
  expect((await first.applications.get(first.rider)).status).toBe('APPROVED');

  // The second application finishes independently under its own store manager.
  const secondDocs = (await second.applications.get(second.rider)).documents;
  for (const doc of secondDocs)
    await second.onboarding.review(outsider, doc.id, true, '', { role: 'STORE_MANAGER' });
  expect((await second.applications.get(second.rider)).status).toBe('APPROVED');
});

test('a config change mid-review cannot move the checklist until a rejection re-entry', async () => {
  const { admin, store } = await seedReviewUsers();
  const entry = await bootstrapUnderReview(uuidV7(), store);
  const { rider, applications, onboarding, config } = entry;
  try {
    expect((await applications.get(rider)).requiredDocuments).toEqual(REVIEW_DOC_TYPES);
    const byType = async (type: string) =>
      (await applications.get(rider)).documents.find((doc) => doc.type === type)!;
    // Narrow the live policy: the in-review checklist must not move.
    await config.update(admin, 'requiredRiderDocuments', ['licence', 'vehicle_rc']);
    expect((await applications.get(rider)).requiredDocuments).toEqual(REVIEW_DOC_TYPES);
    // Approving only the two live-required documents does not approve the app.
    await onboarding.review(admin, (await byType('licence')).id, true, '', {
      role: 'SUPER_ADMIN',
    });
    await onboarding.review(admin, (await byType('vehicle_rc')).id, true, '', {
      role: 'SUPER_ADMIN',
    });
    expect((await applications.get(rider)).status).toBe('UNDER_REVIEW');
    // A stale decision on an already-decided document conflicts.
    await expect(
      onboarding.review(admin, (await byType('licence')).id, true, '', {
        role: 'SUPER_ADMIN',
      }),
    ).rejects.toThrow('DOCUMENT_STATE_INVALID');
    // Reject a pending document from the original checklist and resubmit
    // a document from the narrowed policy to enter review again.
    await onboarding.review(admin, (await byType('bank_proof')).id, false, 'Illegible scan', {
      role: 'SUPER_ADMIN',
    });
    expect((await applications.get(rider)).status).toBe('REJECTED');
    await onboarding.registerDocument(rider, 'licence', uuidV7());
    const resubmitted = await applications.get(rider);
    expect(resubmitted.status).toBe('UNDER_REVIEW');
    expect(resubmitted.requiredDocuments).toEqual(['licence', 'vehicle_rc']);
    const resubmittedSnapshot = await sql<{
      review_required_documents: string[] | null;
    }>`SELECT review_required_documents FROM rider_profiles WHERE user_id=${rider}::uuid`.execute(
      db.db,
    );
    expect(resubmittedSnapshot.rows[0]?.review_required_documents).toEqual([
      'licence',
      'vehicle_rc',
    ]);
    // The refreshed snapshot decides completion using the two live-required documents.
    await onboarding.review(
      admin,
      resubmitted.documents.find((doc) => doc.type === 'licence' && doc.status === 'PENDING')!.id,
      true,
      '',
      { role: 'SUPER_ADMIN' },
    );
    expect((await applications.get(rider)).status).toBe('APPROVED');
  } finally {
    await config.update(admin, 'requiredRiderDocuments', REVIEW_DOC_TYPES);
  }
});
