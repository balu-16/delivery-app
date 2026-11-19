import { sql } from 'kysely';
import { uuidV7 } from '../../../src/common/ids/ids.js';
import { PostgresCartService } from '../../../src/modules/cart/infrastructure/postgres-carts.js';
import { createDatabase, type DatabaseHandle } from '../../../src/platform/database/database.js';
import { closeP5World, createP5World, type P5World } from '../../helpers/p5-world.js';

let world: P5World;
let single: DatabaseHandle;
let race: DatabaseHandle;
beforeAll(async () => {
  world = await createP5World();
  // Every cart-write query must run on the caller's client: with one pooled
  // connection any pool checkout inside the transaction would deadlock.
  single = createDatabase(world.services.databaseUrl, 1);
  // The version race needs one connection per writer so all six reach the
  // database together; generous timeouts cover Sydney round trips plus the
  // advisory-lock queue behind the winner.
  race = createDatabase(world.services.databaseUrl, 6, 60000, undefined, 30000);
}, 180000);
afterAll(async () => {
  await single?.close();
  await race?.close();
  await closeP5World(world);
}, 180000);

function carts(pool: DatabaseHandle = single) {
  return new PostgresCartService(pool.db, world.config, {} as never);
}

test('pool-size-one cart write batches the read and the line-plus-version write', async () => {
  const variant = await world.variant();
  const result = await carts().putItem(world.customer, variant.id, '2', {
    expectedVersion: 1,
    addressId: world.address,
  });
  expect(result.cart.version).toBe(2);
  expect(result.cart.lines).toHaveLength(1);
  expect(result.cart.lines[0]).toMatchObject({ variantId: variant.id, quantity: '2' });
  const reread = await carts().get(world.customer);
  expect(reread?.version).toBe(2);
});

test('concurrent same-version writes commit exactly once and bump once', async () => {
  const address = uuidV7();
  await sql`INSERT INTO addresses(id,user_id,line1,pincode,contact_name,contact_phone,point,is_default)
    VALUES(${address}::uuid,${world.otherCustomer}::uuid,'road','560001','name','+919876543210',ST_SetSRID(ST_MakePoint(77.5,13),4326)::geography,true)`.execute(
    world.db.db,
  );
  const variants = await Promise.all(
    Array.from({ length: 6 }, () => world.variant({ stock: 10n })),
  );
  const attempts = await Promise.allSettled(
    variants.map((variant) =>
      carts(race).putItem(world.otherCustomer, variant.id, '1', {
        expectedVersion: 1,
        addressId: address,
      }),
    ),
  );
  const fulfilled = attempts.filter((attempt) => attempt.status === 'fulfilled');
  expect(fulfilled).toHaveLength(1);
  for (const attempt of attempts) {
    if (attempt.status === 'rejected')
      expect(String((attempt.reason as Error)?.message ?? attempt.reason)).toContain(
        'CONCURRENT_MODIFICATION',
      );
  }
  const cart = await carts().get(world.otherCustomer);
  expect(cart?.version).toBe(2);
  expect(cart?.lines).toHaveLength(1);
  // The winner's version accepts the next write.
  const next = await carts().putItem(world.otherCustomer, variants[0]!.id, '2', {
    expectedVersion: 2,
  });
  expect(next.cart.version).toBe(3);
});
