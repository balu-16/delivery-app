import { jest } from '@jest/globals';
import { sql } from 'kysely';
import { uuidV7 } from '../../../src/common/ids/ids.js';
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
      makerRole: 'ADMIN',
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
