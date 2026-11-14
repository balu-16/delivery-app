import { resolve } from 'node:path';
import { runner } from 'node-pg-migrate';
import { sql } from 'kysely';
import { uuidV7 } from '../../../src/common/ids/ids.js';
import { createDatabase, type DatabaseHandle } from '../../../src/platform/database/database.js';
import { AdminComplianceOperations } from '../../../src/modules/compliance/infrastructure/admin-operations.js';
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
}, 120000);
afterAll(async () => {
  await db?.close();
  await services?.stop();
}, 120000);

test('fraud and reconciliation review is audited, role protected and has no money side effects', async () => {
  const admin = uuidV7(),
    ordinary = uuidV7(),
    signal = uuidV7(),
    finding = uuidV7();
  await sql`INSERT INTO users(id,pool,cognito_sub,normalized_email,name) VALUES
    (${admin}::uuid,'WORKFORCE',${admin},${`${admin}@test.example`},'Admin'),
    (${ordinary}::uuid,'WORKFORCE',${ordinary},${`${ordinary}@test.example`},'Agent')`.execute(
    db.db,
  );
  await sql`INSERT INTO user_roles(user_id,role) VALUES (${admin}::uuid,'SUPER_ADMIN'),(${ordinary}::uuid,'SUPPORT_AGENT')`.execute(
    db.db,
  );
  await sql`INSERT INTO fraud_signals(id,kind,severity,reference) VALUES (${signal}::uuid,'CHECKOUT_VELOCITY','WARN',${signal})`.execute(
    db.db,
  );
  await sql`INSERT INTO reconciliation_findings(id,kind,severity,aggregate_type,aggregate_id,reference) VALUES (${finding}::uuid,'MISMATCH','WARN','order',${finding},${finding})`.execute(
    db.db,
  );
  const service = new AdminComplianceOperations(db.db);
  await expect(service.review('fraud', signal, ordinary, 'DISMISSED', 'reviewed')).rejects.toThrow(
    'FORBIDDEN',
  );
  await service.review('fraud', signal, admin, 'ESCALATED', 'investigate');
  await service.review('reconciliation', finding, admin, 'RESOLVED', 'verified');
  await expect(service.review('fraud', signal, admin, 'DISMISSED', 'duplicate')).rejects.toThrow(
    'RESOURCE_CONFLICT',
  );
  const reviews = await sql<{
    n: string;
  }>`SELECT count(*)::text AS n FROM compliance_reviews WHERE subject_id IN (${signal}::uuid,${finding}::uuid)`.execute(
    db.db,
  );
  expect(reviews.rows[0]?.n).toBe('2');
  const findings = await sql<{
    status: string;
  }>`SELECT status FROM reconciliation_findings WHERE id=${finding}::uuid`.execute(db.db);
  expect(findings.rows[0]?.status).toBe('RESOLVED');
});

test('erasure retries blockers and revokes locally before provider cleanup', async () => {
  const { ErasureProcessor } =
    await import('../../../src/modules/compliance/infrastructure/erasure-processor.js');
  const user = uuidV7(),
    request = uuidV7();
  await sql`INSERT INTO users(id,pool,cognito_sub,normalized_email,name) VALUES (${user}::uuid,'CUSTOMER',${user},${`${user}@test.example`},'Private name')`.execute(
    db.db,
  );
  await sql`INSERT INTO user_roles(user_id,role) VALUES (${user}::uuid,'CUSTOMER')`.execute(db.db);
  await sql`INSERT INTO erasure_requests(id,user_id,status) VALUES (${request}::uuid,${user}::uuid,'REQUESTED')`.execute(
    db.db,
  );
  let active = true;
  const processor = new ErasureProcessor(
    db.db,
    { hasLiveObligations: async () => active },
    { hasUnsettledPayout: async () => false } as never,
    { anonymizeUser: async () => undefined },
    { fenceForErasure: async () => undefined, eraseFenced: async () => true },
  );
  await processor.runOne();
  const blocked = await sql<{
    status: string;
    blockers: string[];
  }>`SELECT status,blockers FROM erasure_requests WHERE id=${request}::uuid`.execute(db.db);
  expect(blocked.rows[0]).toMatchObject({ status: 'BLOCKED', blockers: ['ACTIVE_SUBSCRIPTION'] });
  active = false;
  await sql`UPDATE erasure_requests SET retry_after=clock_timestamp() WHERE id=${request}::uuid`.execute(
    db.db,
  );
  await processor.runOne();
  const local = await sql<{
    status: string;
    name: string;
    cognito_sub: string;
  }>`SELECT status,name,cognito_sub FROM users WHERE id=${user}::uuid`.execute(db.db);
  expect(local.rows[0]).toEqual({ status: 'DELETED', name: '[erased]', cognito_sub: user });
  await processor.runOne();
  const pending = await sql<{
    status: string;
    identity_sync_id: string;
  }>`SELECT status,identity_sync_id FROM erasure_requests WHERE id=${request}::uuid`.execute(db.db);
  expect(pending.rows[0]?.status).toBe('CLEANUP');
  await sql`UPDATE identity_sync_operations SET state='COMPLETE' WHERE id=${pending.rows[0]!.identity_sync_id}::uuid`.execute(
    db.db,
  );
  await sql`UPDATE erasure_requests SET retry_after=clock_timestamp() WHERE id=${request}::uuid`.execute(
    db.db,
  );
  await processor.runOne();
  const completed = await sql<{
    status: string;
  }>`SELECT status FROM erasure_requests WHERE id=${request}::uuid`.execute(db.db);
  expect(completed.rows[0]?.status).toBe('COMPLETE');
});

test('personal export streams privately, scopes downloads and excludes internal support notes', async () => {
  const { ExportService } =
    await import('../../../src/modules/compliance/infrastructure/export-service.js');
  const { ExportWorker } =
    await import('../../../src/modules/compliance/infrastructure/export-worker.js');
  const user = uuidV7(),
    other = uuidV7(),
    ticket = uuidV7();
  await sql`INSERT INTO users(id,pool,cognito_sub,normalized_email,name) VALUES (${user}::uuid,'CUSTOMER',${user},${`${user}@test.example`},'Owner'),(${other}::uuid,'CUSTOMER',${other},${`${other}@test.example`},'Other')`.execute(
    db.db,
  );
  await sql`INSERT INTO support_tickets(id,owner_id,category,status,first_response_due_at,resolution_due_at) VALUES (${ticket}::uuid,${user}::uuid,'OTHER','OPEN',clock_timestamp(),clock_timestamp())`.execute(
    db.db,
  );
  await sql`INSERT INTO support_ticket_messages(id,ticket_id,author_id,body,internal) VALUES (${uuidV7()}::uuid,${ticket}::uuid,${user}::uuid,'Public message',false),(${uuidV7()}::uuid,${ticket}::uuid,${user}::uuid,'Secret internal note',true)`.execute(
    db.db,
  );
  const objects = new Map<string, string>();
  const storage = {
    putPrivateStream: async (key: string, stream: AsyncIterable<Buffer>) => {
      let data = '';
      for await (const chunk of stream) data += chunk.toString();
      objects.set(key, data);
    },
    signedRead: async (key: string) => `signed:${key}`,
    remove: async (key: string) => {
      objects.delete(key);
    },
  } as never;
  const config = {
    get: async (key: string) =>
      ({
        reportExportMaxRows: 1000,
        reportExportMaxBytes: 1048576,
        reportExportTimeoutSeconds: 30,
        reportExportRetentionDays: 7,
        reportDownloadTtlSeconds: 300,
      })[key],
  } as never;
  const reports = { page: async () => ({ rows: [], nextCursor: null }) } as never;
  const service = new ExportService(db.db, storage, config, reports),
    worker = new ExportWorker(db.db, storage, config, reports);
  const id = await service.create(user, 'CUSTOMER', 'personal', {}, 'privacy-export-1');
  expect(await service.create(user, 'CUSTOMER', 'personal', {}, 'privacy-export-1')).toBe(id);
  await worker.runOne();
  expect(((await service.detail(user, 'CUSTOMER', id)) as { status: string }).status).toBe(
    'COMPLETE',
  );
  await expect(service.download(other, 'CUSTOMER', id)).rejects.toThrow('RESOURCE_NOT_FOUND');
  expect((await service.download(user, 'CUSTOMER', id)).url).toMatch(/^signed:/);
  const contents = [...objects.values()][0]!;
  expect(contents).toContain('Public message');
  expect(contents).not.toContain('Secret internal note');
});

test('advisory fraud scans use configured thresholds and deduplicate repeated scans', async () => {
  const { FraudReviewScanner } =
    await import('../../../src/modules/compliance/infrastructure/fraud-review.js');
  const user = uuidV7();
  await sql`INSERT INTO users(id,pool,cognito_sub,normalized_email,name) VALUES (${user}::uuid,'CUSTOMER',${user},${`${user}@test.example`},'Scanner User')`.execute(
    db.db,
  );
  for (let i = 0; i < 2; i++)
    await sql`INSERT INTO payment_attempts(id,aggregate_id,kind,user_id,operation_reference,gateway,amount_paise,currency,status) VALUES (${uuidV7()}::uuid,${uuidV7()}::uuid,'WALLET_TOPUP',${user}::uuid,${`scan-${uuidV7().replaceAll('-', '')}`},'fake',100,'INR','FAILED')`.execute(
      db.db,
    );
  const cfg = {
    get: async (k: string) =>
      ({
        fraudWindowHours: 24,
        fraudFailedPaymentThreshold: 2,
        fraudCancellationThreshold: 5,
        fraudCodRefusalThreshold: 3,
        fraudCouponHoardThreshold: 10,
        fraudImpossibleGpsKph: 180,
        fraudPickerShortRateBps: 3000,
        fraudPickerMinLines: 20,
      })[k],
  } as never;
  const scanner = new FraudReviewScanner(db.db, cfg);
  await scanner.runOnce();
  await scanner.runOnce();
  const rows = await sql<{
    n: string;
  }>`SELECT count(*)::text AS n FROM fraud_signals WHERE user_id=${user}::uuid AND kind='REPEATED_PAYMENT_FAILURES'`.execute(
    db.db,
  );
  expect(rows.rows[0]?.n).toBe('1');
  const state = await sql<{
    status: string;
  }>`SELECT status FROM users WHERE id=${user}::uuid`.execute(db.db);
  expect(state.rows[0]?.status).toBe('ACTIVE');
});

test('retention clears old payloads but preserves notification and idempotency dedupe records', async () => {
  const { ComplianceRetention } =
    await import('../../../src/modules/compliance/infrastructure/retention.js');
  const user = uuidV7(),
    notification = uuidV7();
  await sql`INSERT INTO users(id,pool,cognito_sub,normalized_email,name) VALUES (${user}::uuid,'CUSTOMER',${user},${`${user}@test.example`},'Retention User')`.execute(
    db.db,
  );
  await sql`INSERT INTO notifications(id,user_id,channel,template_key,locale,category,class,payload,status,dedupe_key,created_at) VALUES (${notification}::uuid,${user}::uuid,'INBOX','order.confirmed','en','ORDER_UPDATES','TRANSACTIONAL','{"sensitive":"private"}'::jsonb,'SENT',${notification},clock_timestamp()-interval '91 days')`.execute(
    db.db,
  );
  const actor = user;
  await sql`INSERT INTO idempotency_keys(actor,audience,method,resource,key,request_hash,operation_id,state,response_status,response_body,response_expires_at,updated_at) VALUES (${actor},'customer','POST','/test','test-retention','hash',${uuidV7()}::uuid,'COMPLETED',200,'{"sensitive":"private"}'::jsonb,clock_timestamp()-interval '1 hour',clock_timestamp()-interval '25 hours')`.execute(
    db.db,
  );
  await new ComplianceRetention(db.db, {
    get: async (key: string) =>
      ({ retentionBatchSize: 100, notificationRetentionDays: 90, responseCacheRetentionHours: 24 })[
        key
      ],
  } as never).runOnce();
  const n = await sql<{
    payload: object;
  }>`SELECT payload FROM notifications WHERE id=${notification}::uuid`.execute(db.db);
  const i = await sql<{
    response_body: object | null;
    request_hash: string;
  }>`SELECT response_body,request_hash FROM idempotency_keys WHERE actor=${actor}`.execute(db.db);
  expect(n.rows[0]?.payload).toEqual({});
  expect(i.rows[0]).toEqual({ response_body: null, request_hash: 'hash' });
});

test('outbox replay is audited and restricts consumer to registered names', async () => {
  const { AdminQueueOperations } =
    await import('../../../src/modules/compliance/infrastructure/admin-queue-operations.js');
  const user = uuidV7(),
    event = uuidV7();
  await sql`INSERT INTO users(id,pool,cognito_sub,normalized_email,name) VALUES (${user}::uuid,'WORKFORCE',${user},${`${user}@test.example`},'Ops')`.execute(
    db.db,
  );
  await sql`INSERT INTO outbox_events(id,event_type,schema_version,aggregate_type,aggregate_id,aggregate_version,correlation_id,payload) VALUES (${event}::uuid,'test',1,'test',${uuidV7()}::uuid,1,'test','{}')`.execute(
    db.db,
  );
  await sql`INSERT INTO outbox_deliveries(event_id,consumer,suspended_at) VALUES (${event}::uuid,'notifications',clock_timestamp())`.execute(
    db.db,
  );
  const ops = new AdminQueueOperations(db.db);
  await expect(ops.replayOutbox(event, 'arbitrary', user, 'retry')).rejects.toThrow(
    'INVALID_REPLAY',
  );
  expect(await ops.outbox()).toMatchObject({
    pending: expect.any(String),
    suspended: expect.any(String),
  });
  await ops.replayOutbox(event, 'notifications', user, 'retry');
  const result = await sql<{
    suspended_at: Date | null;
  }>`SELECT suspended_at FROM outbox_deliveries WHERE event_id=${event}::uuid`.execute(db.db);
  expect(result.rows[0]?.suspended_at).toBeNull();
  await expect(ops.replayOutbox(event, 'notifications', user, 'retry')).rejects.toThrow(
    'FAILED_JOB_NOT_FOUND',
  );
});

test('erasure during export upload prevents finalization and removes the orphan object', async () => {
  const { ExportService } =
    await import('../../../src/modules/compliance/infrastructure/export-service.js');
  const { ExportWorker } =
    await import('../../../src/modules/compliance/infrastructure/export-worker.js');
  const user = uuidV7(),
    objects = new Map<string, string>();
  await sql`INSERT INTO users(id,pool,cognito_sub,normalized_email,name) VALUES (${user}::uuid,'CUSTOMER',${user},${`${user}@test.example`},'Owner')`.execute(
    db.db,
  );
  const storage = {
    putPrivateStream: async (key: string, stream: AsyncIterable<Buffer>) => {
      let value = '';
      for await (const chunk of stream) value += chunk.toString();
      objects.set(key, value);
      await sql`UPDATE users SET status='DELETED' WHERE id=${user}::uuid`.execute(db.db);
    },
    signedRead: async (key: string) => key,
    remove: async (key: string) => {
      objects.delete(key);
    },
  } as never;
  const config = {
    get: async (key: string) =>
      ({
        reportExportMaxRows: 1000,
        reportExportMaxBytes: 1048576,
        reportExportTimeoutSeconds: 30,
        reportExportRetentionDays: 7,
        reportDownloadTtlSeconds: 300,
      })[key],
  } as never;
  const reports = { page: async () => ({ rows: [], nextCursor: null }) } as never;
  const service = new ExportService(db.db, storage, config, reports),
    worker = new ExportWorker(db.db, storage, config, reports);
  const id = await service.create(user, 'CUSTOMER', 'personal', {}, 'race-test');
  await worker.runOne();
  await expect(service.download(user, 'CUSTOMER', id)).rejects.toThrow('RESOURCE_NOT_FOUND');
  await worker.cleanup();
  expect(objects.size).toBe(0);
  const row = await sql<{
    status: string;
  }>`SELECT status FROM compliance_export_jobs WHERE id=${id}::uuid`.execute(db.db);
  expect(row.rows[0]?.status).not.toBe('COMPLETE');
});

test('legal hold blocks erasure until released, with audited operations', async () => {
  const { PrivacyRequests } =
    await import('../../../src/modules/compliance/infrastructure/privacy-requests.js');
  const { MakerChecker } =
    await import('../../../src/modules/compliance/infrastructure/maker-checker.js');
  const { ErasureProcessor } =
    await import('../../../src/modules/compliance/infrastructure/erasure-processor.js');
  const user = uuidV7(),
    admin = uuidV7(),
    request = uuidV7();
  await sql`INSERT INTO users(id,pool,cognito_sub,normalized_email,name) VALUES (${user}::uuid,'CUSTOMER',${user},${`${user}@test.example`},'Customer'),(${admin}::uuid,'WORKFORCE',${admin},${`${admin}@test.example`},'Admin')`.execute(
    db.db,
  );
  await sql`INSERT INTO erasure_requests(id,user_id,status) VALUES (${request}::uuid,${user}::uuid,'REQUESTED')`.execute(
    db.db,
  );
  const privacy = new PrivacyRequests(db.db, {
    create: (actions) => new MakerChecker(db.db, actions),
  });
  const hold = await privacy.createHold(admin, user, 'legal preservation');
  const processor = new ErasureProcessor(
    db.db,
    { hasLiveObligations: async () => false },
    { hasUnsettledPayout: async () => false } as never,
    { anonymizeUser: async () => undefined },
    { fenceForErasure: async () => undefined, eraseFenced: async () => true },
  );
  await processor.runOne();
  const result = await sql<{
    status: string;
    blockers: string[];
  }>`SELECT status,blockers FROM erasure_requests WHERE id=${request}::uuid`.execute(db.db);
  expect(result.rows[0]).toMatchObject({ status: 'BLOCKED', blockers: ['LEGAL_HOLD'] });
  await privacy.releaseHold(admin, hold, 'resolved');
  await privacy.retry(admin, request);
  await processor.runOne();
  const userState = await sql<{
    status: string;
  }>`SELECT status FROM users WHERE id=${user}::uuid`.execute(db.db);
  expect(userState.rows[0]?.status).toBe('DELETED');
});

test('private media fencing waits for signed capability expiry and deletes only eligible objects', async () => {
  const { LocalPrivateUploads } = await import('../../../src/adapters/storage/local-private.js');
  const { mkdtemp, writeFile, readFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const user = uuidV7(),
    media = uuidV7(),
    file = uuidV7(),
    evidence = uuidV7(),
    evidenceFile = uuidV7();
  const directory = await mkdtemp(join(tmpdir(), 'delivery-erasure-test-'));
  try {
    await sql`INSERT INTO users(id,pool,cognito_sub,normalized_email,name) VALUES (${user}::uuid,'WORKFORCE',${user},${`${user}@test.example`},'Rider')`.execute(
      db.db,
    );
    await sql`INSERT INTO private_media(id,owner_id,purpose,content_type,size_bytes,state,upload_nonce,file_key) VALUES (${media}::uuid,${user}::uuid,'RIDER_KYC','application/pdf',10,'STORED',${uuidV7()}::uuid,${file}::uuid),(${evidence}::uuid,${user}::uuid,'PAYOUT_EVIDENCE','application/pdf',10,'STORED',${uuidV7()}::uuid,${evidenceFile}::uuid)`.execute(
      db.db,
    );
    await writeFile(join(directory, file), 'private');
    await writeFile(join(directory, evidenceFile), 'legal');
    const uploads = new LocalPrivateUploads(db.db, 'test-secret', directory, 1024, 300, 60);
    await db.db.transaction().execute((tx) => uploads.fenceForErasure(user, tx));
    expect(await uploads.eraseFenced(user)).toBe(false);
    await sql`UPDATE privacy_media_fences SET ready_at=clock_timestamp()-interval '1 second' WHERE owner_id=${user}::uuid`.execute(
      db.db,
    );
    expect(await uploads.eraseFenced(user)).toBe(true);
    await expect(readFile(join(directory, file))).rejects.toThrow();
    expect((await readFile(join(directory, evidenceFile))).toString()).toBe('legal');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('account lock serializes erasure against new customer obligations', async () => {
  const { lockActiveCustomer } =
    await import('../../../src/modules/identity/contracts/account-lock.js');
  const user = uuidV7();
  await sql`INSERT INTO users(id,pool,cognito_sub,normalized_email,name) VALUES (${user}::uuid,'CUSTOMER',${user},${`${user}@test.example`},'Customer')`.execute(
    db.db,
  );
  let acquired!: () => void, release!: () => void;
  const entered = new Promise<void>((resolve) => {
    acquired = resolve;
  });
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  const erase = db.db.transaction().execute(async (tx) => {
    await lockActiveCustomer(user, tx);
    acquired();
    await wait;
    await sql`UPDATE users SET status='DELETED' WHERE id=${user}::uuid`.execute(tx);
  });
  await entered;
  const creation = db.db.transaction().execute(async (tx) => lockActiveCustomer(user, tx));
  release();
  await erase;
  await expect(creation).rejects.toThrow('ACCOUNT_DISABLED');
});

test('identity cleanup disables only the matching pool and deleted customer cannot bootstrap again', async () => {
  const { LocalIdentityAdmin } = await import('../../../src/adapters/auth/local-admin.js');
  const { IdentitySyncWorker } =
    await import('../../../src/modules/identity/infrastructure/identity-sync-worker.js');
  const { IdentityService } =
    await import('../../../src/modules/identity/infrastructure/identity-service.js');
  const { DatabaseIdentityAccess } =
    await import('../../../src/modules/identity/infrastructure/identity-access.js');
  const subject = uuidV7(),
    user = uuidV7(),
    operation = uuidV7();
  await sql`INSERT INTO users(id,pool,cognito_sub,normalized_email,name,status) VALUES (${user}::uuid,'CUSTOMER',${subject},${`${user}@test.example`},'[erased]','DELETED')`.execute(
    db.db,
  );
  await sql`INSERT INTO local_identity_directory(pool,username,sub,email,name) VALUES ('CUSTOMER',${subject},${subject},${`${subject}@customer.test`},'Customer'),('WORKFORCE',${subject},${subject},${`${subject}@workforce.test`},'Staff')`.execute(
    db.db,
  );
  await sql`INSERT INTO identity_sync_operations(id,user_id,action,details) VALUES (${operation}::uuid,${user}::uuid,'USER_BLOCKED','{}')`.execute(
    db.db,
  );
  const worker = new IdentitySyncWorker(db.db, {
    CUSTOMER: new LocalIdentityAdmin(db.db, 'CUSTOMER'),
    WORKFORCE: new LocalIdentityAdmin(db.db, 'WORKFORCE'),
  });
  for (let i = 0; i < 20; i++) {
    await worker.runOne();
    const state = await sql<{
      state: string;
    }>`SELECT state FROM identity_sync_operations WHERE id=${operation}::uuid`.execute(db.db);
    if (state.rows[0]?.state === 'COMPLETE') break;
  }
  const directory = await sql<{
    pool: string;
    disabled: boolean;
  }>`SELECT pool,disabled FROM local_identity_directory WHERE sub=${subject} ORDER BY pool`.execute(
    db.db,
  );
  expect(directory.rows).toEqual([
    { pool: 'CUSTOMER', disabled: true },
    { pool: 'WORKFORCE', disabled: false },
  ]);
  const service = new IdentityService(db.db, new DatabaseIdentityAccess(db.db));
  await expect(
    service.bootstrap({
      pool: 'CUSTOMER',
      sub: subject,
      tokenUse: 'id',
      groups: [],
      email: 'former@example.test',
      emailVerified: true,
      expiresAt: 9999999999,
    }),
  ).rejects.toThrow('ACCOUNT_DISABLED');
});

test('rider GPS cleanup fences ingest and completes only after bounded history deletion', async () => {
  const { Redis } = await import('ioredis');
  const { RedisRiderGeo } =
    await import('../../../src/modules/tracking/infrastructure/redis-geo.js');
  const { PostgresTrackingPrivacy } =
    await import('../../../src/modules/tracking/infrastructure/privacy.js');
  const { ErasureProcessor } =
    await import('../../../src/modules/compliance/infrastructure/erasure-processor.js');
  const rider = uuidV7(),
    req = uuidV7(),
    sync = uuidV7(),
    redis = new Redis(services.redisUrl);
  try {
    await sql`INSERT INTO users(id,pool,cognito_sub,normalized_email,name,status) VALUES (${rider}::uuid,'WORKFORCE',${rider},${`${rider}@test.example`},'Erased','DELETED')`.execute(
      db.db,
    );
    await sql`INSERT INTO rider_status(rider_id,last_location,last_location_at,last_location_source) VALUES (${rider}::uuid,ST_SetSRID(ST_MakePoint(77,12),4326)::geography,clock_timestamp(),'GPS')`.execute(
      db.db,
    );
    await sql`SELECT ensure_location_partition(clock_timestamp()::date)`.execute(db.db);
    await sql`INSERT INTO rider_location_history(rider_id,ts,location) SELECT ${rider}::uuid,clock_timestamp()-x*interval '1 second',ST_SetSRID(ST_MakePoint(77,12),4326)::geography FROM generate_series(1,3) x`.execute(
      db.db,
    );
    await sql`INSERT INTO identity_sync_operations(id,user_id,action,details,state) VALUES (${sync}::uuid,${rider}::uuid,'USER_BLOCKED','{}','COMPLETE')`.execute(
      db.db,
    );
    await sql`INSERT INTO erasure_requests(id,user_id,status,identity_sync_id) VALUES (${req}::uuid,${rider}::uuid,'CLEANUP',${sync}::uuid)`.execute(
      db.db,
    );
    const geo = new RedisRiderGeo(redis),
      tracking = new PostgresTrackingPrivacy(db.db, geo, 2);
    await db.db.transaction().execute((tx) => tracking.fence(rider, tx));
    await sql`UPDATE erasure_requests SET retry_after=clock_timestamp()+interval '1 hour' WHERE id<>${req}::uuid AND status IN ('REQUESTED','BLOCKED','CLEANUP')`.execute(
      db.db,
    );
    const processor = new ErasureProcessor(
      db.db,
      { hasLiveObligations: async () => false },
      { hasUnsettledPayout: async () => false } as never,
      { anonymizeUser: async () => undefined },
      { fenceForErasure: async () => undefined, eraseFenced: async () => true },
      tracking,
    );
    await processor.runOne();
    const first = await sql<{
      status: string;
    }>`SELECT status FROM erasure_requests WHERE id=${req}::uuid`.execute(db.db);
    expect(first.rows[0]?.status).toBe('CLEANUP');
    expect(
      await geo.updateMember(rider, { lat: 12, lng: 77, ts: new Date().toISOString() }, 60),
    ).toBe(false);
    await sql`UPDATE erasure_requests SET retry_after=clock_timestamp() WHERE id=${req}::uuid`.execute(
      db.db,
    );
    await processor.runOne();
    const result = await sql<{
      status: string;
      remaining: string;
      current_null: boolean;
    }>`SELECT r.status,(SELECT count(*)::text FROM rider_location_history WHERE rider_id=${rider}::uuid) AS remaining,(SELECT last_location IS NULL FROM rider_status WHERE rider_id=${rider}::uuid) AS current_null FROM erasure_requests r WHERE r.id=${req}::uuid`.execute(
      db.db,
    );
    expect(result.rows[0]).toEqual({ status: 'COMPLETE', remaining: '0', current_null: true });
  } finally {
    await redis.del(`delivery:{rider-geo}:erased:${rider}`);
    await redis.quit();
  }
});
