import { jest } from '@jest/globals';
import { sql } from 'kysely';
import { uuidV7 } from '../../../src/common/ids/ids.js';
import { AdminComplianceOperations } from '../../../src/modules/compliance/infrastructure/admin-operations.js';
import { MakerChecker } from '../../../src/modules/compliance/infrastructure/maker-checker.js';
import { closeP5World, createP5World, type P5World } from '../../helpers/p5-world.js';

let world: P5World;
const timeout = process.env.AWS_P13_INTEGRATION === 'yes' ? 300000 : 120000;
if (process.env.AWS_P13_INTEGRATION === 'yes') jest.setTimeout(timeout);
beforeAll(async () => {
  world = await createP5World();
}, timeout);
afterAll(async () => {
  if (world) await closeP5World(world);
}, timeout);

it('rejects a tampered approval payload without executing or auditing approval', async () => {
  const checker = uuidV7();
  await sql`INSERT INTO users(id,pool,cognito_sub,normalized_email,name)
    VALUES(${checker}::uuid,'WORKFORCE',${checker},${`${checker}@example.invalid`},'checker')`.execute(
    world.db.db,
  );
  await sql`INSERT INTO user_roles(user_id,role) VALUES(${checker}::uuid,'SUPER_ADMIN')`.execute(
    world.db.db,
  );
  let executions = 0;
  const service = new MakerChecker(world.db.db, {
    test: {
      version: 1,
      makerRole: 'SUPER_ADMIN',
      checkerRole: 'SUPER_ADMIN',
      ttlSeconds: 300,
      validate: (payload) => typeof payload === 'object' && payload !== null,
      execute: async () => {
        executions++;
      },
    },
  });
  const id = await service.request(world.admin, 'test', { amount: 100 });
  await sql`UPDATE maker_checker_requests SET payload=${JSON.stringify({ amount: 999 })}::jsonb
    WHERE id=${id}::uuid`.execute(world.db.db);
  await expect(service.approve(checker, id)).rejects.toThrow('APPROVAL_INVALID');
  expect(executions).toBe(0);
  const result = await sql<{ status: string; checker_id: string | null; executions: string }>`
    SELECT status,checker_id::text,
      (SELECT count(*)::text FROM audit_log WHERE action='APPROVAL_EXECUTED' AND subject_id=${id}) AS executions
    FROM maker_checker_requests WHERE id=${id}::uuid`.execute(world.db.db);
  expect(result.rows[0]).toEqual({ status: 'PENDING', checker_id: null, executions: '0' });
});

it('exposes server-calculated canApprove and canReject with a reason', async () => {
  const operations = new AdminComplianceOperations(world.db.db);
  const maker = uuidV7();
  await sql`INSERT INTO users(id,pool,cognito_sub,normalized_email,name)
    VALUES(${maker}::uuid,'WORKFORCE',${maker},${`${maker}@example.invalid`},'maker')`.execute(
    world.db.db,
  );
  await sql`INSERT INTO user_roles(user_id,role) VALUES(${maker}::uuid,'SUPER_ADMIN')`.execute(
    world.db.db,
  );
  let executions = 0;
  const service = new MakerChecker(world.db.db, {
    capability: {
      version: 1,
      makerRole: 'SUPER_ADMIN',
      checkerRole: 'SUPER_ADMIN',
      ttlSeconds: 300,
      validate: (payload) => typeof payload === 'object' && payload !== null,
      execute: async () => {
        executions++;
      },
    },
  });
  const id = await service.request(maker, 'capability', { amount: 7 });
  const pending = (await operations.detail('approval', id, world.admin)) as {
    canApprove?: boolean;
    canReject?: boolean;
    cannotApproveReason?: string | null;
  };
  expect(pending).toMatchObject({ canApprove: true, canReject: true, cannotApproveReason: null });
  const listed = (await operations.list('approval', undefined, 50, world.admin)) as {
    items: Array<{ id: string; canApprove?: boolean }>;
  };
  expect(listed.items.find((row) => row.id === id)?.canApprove).toBe(true);
  // The maker cannot decide their own request.
  const own = (await operations.detail('approval', id, maker)) as {
    canApprove?: boolean;
    cannotApproveReason?: string | null;
  };
  expect(own.canApprove).toBe(false);
  expect(own.cannotApproveReason).toMatch(/Maker cannot decide/);
  // Execution still rechecks policy in MakerChecker.
  await service.approve(world.admin, id);
  expect(executions).toBe(1);
  const done = (await operations.detail('approval', id, world.admin)) as {
    canApprove?: boolean;
    cannotApproveReason?: string | null;
  };
  expect(done.canApprove).toBe(false);
  expect(done.cannotApproveReason).toMatch(/Already/);
});
