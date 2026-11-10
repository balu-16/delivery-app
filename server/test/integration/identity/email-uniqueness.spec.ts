import { jest } from '@jest/globals';
import { sql } from 'kysely';
import { uuidV7 } from '../../../src/common/ids/ids.js';
import { IdentityService } from '../../../src/modules/identity/infrastructure/identity-service.js';
import { DatabaseIdentityAccess } from '../../../src/modules/identity/infrastructure/identity-access.js';
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

it('enforces normalized email uniqueness within each identity pool without merging subjects', async () => {
  const service = new IdentityService(world.db.db, new DatabaseIdentityAccess(world.db.db));
  const email = `${uuidV7()}@example.invalid`;
  const sub = uuidV7();
  const identity = {
    pool: 'CUSTOMER' as const,
    sub,
    tokenUse: 'id' as const,
    groups: [],
    email: ` ${email.toUpperCase()} `,
    emailVerified: true,
    expiresAt: Math.floor(Date.now() / 1000) + 300,
  };
  const first = await service.bootstrap(identity);
  expect((await service.bootstrap({ ...identity, email })).userId).toBe(first.userId);
  const differentSubject = uuidV7();
  await expect(service.bootstrap({ ...identity, sub: differentSubject, email })).rejects.toThrow();
  const users = await sql<{ pool: string; cognito_sub: string; normalized_email: string }>`
    SELECT pool,cognito_sub,normalized_email FROM users WHERE normalized_email=${email}`.execute(
    world.db.db,
  );
  expect(users.rows).toEqual([{ pool: 'CUSTOMER', cognito_sub: sub, normalized_email: email }]);
  const workforceId = uuidV7();
  await sql`INSERT INTO users(id,pool,cognito_sub,normalized_email,name)
    VALUES(${workforceId}::uuid,'WORKFORCE',${workforceId},${email},'worker')`.execute(world.db.db);
  await expect(
    sql`INSERT INTO users(id,pool,cognito_sub,normalized_email,name)
      VALUES(${uuidV7()}::uuid,'WORKFORCE',${uuidV7()},${email},'duplicate')`.execute(world.db.db),
  ).rejects.toThrow();
  const count = await sql<{
    count: string;
  }>`SELECT count(*)::text AS count FROM users WHERE normalized_email=${email}`.execute(
    world.db.db,
  );
  expect(count.rows[0]?.count).toBe('2');
});
