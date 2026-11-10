import { sql } from 'kysely';
import type { FastifyInstance } from 'fastify';
import { LocalTokenAdapter } from '../../../src/adapters/auth/local.js';
import { createApplication } from '../../../src/bootstrap.js';
import { readEnv } from '../../../src/config/env.schema.js';
import { uuidV7 } from '../../../src/common/ids/ids.js';
import { closeP5World, createP5World, type P5World } from '../../helpers/p5-world.js';
let world: P5World;
let app: Awaited<ReturnType<typeof createApplication>>;
let server: FastifyInstance;
let token = '';
let addressId = '';
let variantId = '';
beforeAll(async () => {
  world = await createP5World();
  const env = readEnv({
    NODE_ENV: 'test',
    APP_ROLE: 'all',
    LOG_LEVEL: 'silent',
    DATABASE_URL: world.services.databaseUrl,
    REDIS_URL: world.services.redisUrl,
    RATE_LIMIT_DEFAULT_PER_MIN: '10000',
    RATE_LIMIT_AUTH_PER_MIN: '10000',
  });
  // Surface-only boot (the probes parameter excludes worker modules): this is a
  // customer API concurrency test.
  app = await createApplication(env, [{ name: 'test', async check() {} }]);
  server = app.getHttpAdapter().getInstance();
  const user = uuidV7();
  addressId = uuidV7();
  await sql`INSERT INTO users(id,pool,cognito_sub,normalized_email,name) VALUES(${user}::uuid,'CUSTOMER','conc-cart','conc-cart@example.invalid','customer')`.execute(
    world.db.db,
  );
  await sql`INSERT INTO user_roles(user_id,role) VALUES(${user}::uuid,'CUSTOMER')`.execute(
    world.db.db,
  );
  await sql`INSERT INTO addresses(id,user_id,line1,pincode,contact_name,contact_phone,point,is_default) VALUES(${addressId}::uuid,${user}::uuid,'road','560001','name','+919876543210',ST_SetSRID(ST_MakePoint(77.5,13),4326)::geography,true)`.execute(
    world.db.db,
  );
  token = await new LocalTokenAdapter(env.LOCAL_JWT_SECRET, world.db.db).issue(
    'CUSTOMER',
    'conc-cart',
    'customer',
    'access',
  );
  const item = await world.variant();
  variantId = item.id;
}, 120000);
afterAll(async () => {
  await app?.close();
  await closeP5World(world);
}, 120000);
const put = (quantity: string, version: number) =>
  server.inject({
    method: 'PUT',
    url: `/v1/customer/cart/items/${variantId}`,
    headers: { authorization: `Bearer ${token}`, 'idempotency-key': uuidV7() },
    payload: { quantity, version, addressId },
  });
it('concurrent writes against one cart version produce exactly one winner', async () => {
  const first = await put('1', 1);
  expect(first.statusCode).toBe(200);
  const version = first.json().cart.version as number;
  // Ten devices race on the same expected version with different quantities.
  const outcomes = await Promise.all(
    Array.from({ length: 10 }, (_, index) => put(String(index + 1), version)),
  );
  expect(outcomes.filter((o) => o.statusCode === 200)).toHaveLength(1);
  expect(outcomes.filter((o) => o.statusCode === 409)).toHaveLength(9);
  expect(
    outcomes
      .filter((o) => o.statusCode === 409)
      .every((o) => o.json().code === 'CONCURRENT_MODIFICATION'),
  ).toBe(true);
  const winner = outcomes.find((o) => o.statusCode === 200)!;
  expect(winner.json().cart.version).toBe(version + 1);
  // The stored quantity matches the winner and the version chain continues.
  const settled = await server.inject({
    method: 'GET',
    url: '/v1/customer/cart',
    headers: { authorization: `Bearer ${token}` },
  });
  expect(settled.json().version).toBe(version + 1);
  const winnerQuantity = String(outcomes.findIndex((o) => o.statusCode === 200) + 1);
  expect(settled.json().lines[0].quantity).toBe(winnerQuantity);
});
it('sequential device writes with fresh versions all succeed in order', async () => {
  let version = (
    await server.inject({
      method: 'GET',
      url: '/v1/customer/cart',
      headers: { authorization: `Bearer ${token}` },
    })
  ).json().version as number;
  for (const quantity of ['2', '3', '4']) {
    const result = await put(quantity, version);
    expect(result.statusCode).toBe(200);
    version = result.json().cart.version as number;
  }
  const settled = await server.inject({
    method: 'GET',
    url: '/v1/customer/cart',
    headers: { authorization: `Bearer ${token}` },
  });
  expect(settled.json().lines[0].quantity).toBe('4');
  expect(settled.json().version).toBe(version);
});
