import { resolve } from 'node:path';
import { runner } from 'node-pg-migrate';
import { sql } from 'kysely';
import { uuidV7 } from '../../../src/common/ids/ids.js';
import { createDatabase, type DatabaseHandle } from '../../../src/platform/database/database.js';
import { DatabaseIdentityAccess } from '../../../src/modules/identity/infrastructure/identity-access.js';
import { IdentityService } from '../../../src/modules/identity/infrastructure/identity-service.js';
import { IdentityAdminService } from '../../../src/modules/identity/infrastructure/admin-service.js';
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

test('concurrent bootstrap converges to one customer and one profile', async () => {
  const service = new IdentityService(db.db, new DatabaseIdentityAccess(db.db));
  const identity = {
    pool: 'CUSTOMER' as const,
    sub: 'concurrent',
    tokenUse: 'id' as const,
    groups: [],
    email: 'parallel@example.test',
    emailVerified: true,
    name: 'Parallel',
    expiresAt: 9999999999,
  };
  const results = await Promise.all(Array.from({ length: 10 }, () => service.bootstrap(identity)));
  expect(new Set(results.map((result) => result.userId)).size).toBe(1);
  const count = await sql<{
    n: string;
  }>`SELECT count(*)::text AS n FROM users u JOIN customer_profiles p ON p.user_id=u.id WHERE u.cognito_sub='concurrent'`.execute(
    db.db,
  );
  expect(count.rows[0]?.n).toBe('1');
});

test('two concurrent super-admin blocks cannot remove the last active super-admin', async () => {
  const a = uuidV7(),
    b = uuidV7();
  await sql`INSERT INTO users(id,pool,cognito_sub,normalized_email,name) VALUES (${a}::uuid,'WORKFORCE','a','a@example.test','A'),(${b}::uuid,'WORKFORCE','b','b@example.test','B')`.execute(
    db.db,
  );
  await sql`INSERT INTO user_roles(user_id,role) VALUES (${a}::uuid,'SUPER_ADMIN'),(${b}::uuid,'SUPER_ADMIN')`.execute(
    db.db,
  );
  const admin = new IdentityAdminService(db.db);
  const result = await Promise.allSettled([
    admin.setBlocked(a, b, true),
    admin.setBlocked(b, a, true),
  ]);
  expect(result.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  const count = await sql<{
    n: string;
  }>`SELECT count(*)::text AS n FROM users u JOIN user_roles r ON r.user_id=u.id WHERE u.status='ACTIVE' AND r.role='SUPER_ADMIN'`.execute(
    db.db,
  );
  expect(count.rows[0]?.n).toBe('1');
});

test('maker-checker enforces current roles, immutable policy, expiration and one execution', async () => {
  const { MakerChecker } =
    await import('../../../src/modules/compliance/infrastructure/maker-checker.js');
  const maker = uuidV7(),
    checker = uuidV7(),
    other = uuidV7();
  for (const [id, name] of [
    [maker, 'maker'],
    [checker, 'checker'],
    [other, 'other'],
  ] as const) {
    await sql`INSERT INTO users(id,pool,cognito_sub,normalized_email,name) VALUES (${id}::uuid,'WORKFORCE',${name},${`${name}@test.invalid`},${name})`.execute(
      db.db,
    );
  }
  await sql`INSERT INTO user_roles(user_id,role) VALUES (${maker}::uuid,'SUPER_ADMIN'),(${checker}::uuid,'SUPER_ADMIN')`.execute(
    db.db,
  );
  let executions = 0;
  const policy = {
    version: 1,
    makerRole: 'SUPER_ADMIN',
    checkerRole: 'SUPER_ADMIN',
    ttlSeconds: 120,
    validate: (p: unknown) => typeof p === 'string',
    execute: async () => {
      executions++;
    },
  };
  const approvals = new MakerChecker(db.db, { example: policy });
  await expect(approvals.request(other, 'example', 'payload')).rejects.toThrow('FORBIDDEN');
  await expect(approvals.request(maker, 'example', { invalid: true })).rejects.toThrow(
    'INVALID_APPROVAL',
  );
  const request = await approvals.request(maker, 'example', 'payload');
  await expect(approvals.approve(other, request)).rejects.toThrow('FORBIDDEN');
  await sql`DELETE FROM user_roles WHERE user_id=${maker}::uuid AND role='SUPER_ADMIN'`.execute(
    db.db,
  );
  await expect(approvals.approve(checker, request)).rejects.toThrow('FORBIDDEN');
  await sql`INSERT INTO user_roles(user_id,role) VALUES (${maker}::uuid,'SUPER_ADMIN')`.execute(
    db.db,
  );
  const changed = new MakerChecker(db.db, { example: { ...policy, version: 2 } });
  await expect(changed.approve(checker, request)).rejects.toThrow('APPROVAL_POLICY_CHANGED');
  const attempts = await Promise.allSettled(
    Array.from({ length: 8 }, () => approvals.approve(checker, request)),
  );
  expect(attempts.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  expect(executions).toBe(1);
  const ownRequest = await approvals.request(maker, 'example', 'self-approved');
  const ownAttempts = await Promise.allSettled(
    Array.from({ length: 8 }, () => approvals.approve(maker, ownRequest)),
  );
  expect(ownAttempts.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  expect(executions).toBe(2);
  const expired = await approvals.request(maker, 'example', 'expired');
  await sql`UPDATE maker_checker_requests SET expires_at=clock_timestamp()-interval '1 second' WHERE id=${expired}::uuid`.execute(
    db.db,
  );
  await expect(approvals.approve(checker, expired)).rejects.toThrow('APPROVAL_INVALID');
});
