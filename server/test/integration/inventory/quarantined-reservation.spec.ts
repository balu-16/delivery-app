import { jest } from '@jest/globals';
import { sql } from 'kysely';
import { uuidV7 } from '../../../src/common/ids/ids.js';
import { PostgresReservations } from '../../../src/modules/inventory/infrastructure/reservations.js';
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

it('never reserves quarantined stock even when the aggregate has sufficient units', async () => {
  const variant = await world.variant({ stock: 0n });
  const quarantine = uuidV7();
  await sql`UPDATE store_inventory SET on_hand=3 WHERE store_id=${world.store}::uuid AND variant_id=${variant.id}::uuid`.execute(
    world.db.db,
  );
  await sql`INSERT INTO inventory_batches(id,store_id,variant_id,batch_code,state,on_hand)
    VALUES(${quarantine}::uuid,${world.store}::uuid,${variant.id}::uuid,'quarantine','QUARANTINED',3)`.execute(
    world.db.db,
  );
  const orderId = uuidV7();
  await sql`INSERT INTO orders(id,order_number,user_id,store_id,address_snapshot,status,payment_status,subtotal_paise,total_paise,amount_due_paise,placed_at)
    VALUES(${orderId}::uuid,${`ORD-${orderId.replaceAll('-', '').toUpperCase()}`},${world.customer}::uuid,${world.store}::uuid,'{}','PENDING_PAYMENT','UNPAID',100,100,100,clock_timestamp())`.execute(
    world.db.db,
  );
  const reservations = new PostgresReservations(world.db.db);
  const input = {
    orderId,
    lines: [{ storeId: world.store, variantId: variant.id, quantity: '1' }],
    targetDeliveryAt: new Date(Date.now() + 60000).toISOString(),
    ttlSeconds: 900,
  };
  await expect(reservations.reserve(input)).rejects.toThrow('INVENTORY_INSUFFICIENT');
  const rejected = await sql<{ reserved: string; allocations: string }>`SELECT
    (SELECT reserved::text FROM store_inventory WHERE store_id=${world.store}::uuid AND variant_id=${variant.id}::uuid) AS reserved,
    (SELECT count(*)::text FROM inventory_allocations WHERE order_id=${orderId}::uuid) AS allocations`.execute(
    world.db.db,
  );
  expect(rejected.rows[0]).toEqual({ reserved: '0', allocations: '0' });
  await sql`UPDATE inventory_batches SET on_hand=1 WHERE store_id=${world.store}::uuid AND variant_id=${variant.id}::uuid AND state='ACTIVE'`.execute(
    world.db.db,
  );
  await sql`UPDATE store_inventory SET on_hand=4 WHERE store_id=${world.store}::uuid AND variant_id=${variant.id}::uuid`.execute(
    world.db.db,
  );
  await reservations.reserve(input);
  const allocations = await sql<{
    state: string;
    quantity: string;
  }>`SELECT b.state,a.quantity::text FROM inventory_allocations a
    JOIN inventory_batches b ON b.id=a.batch_id WHERE a.order_id=${orderId}::uuid`.execute(
    world.db.db,
  );
  expect(allocations.rows).toEqual([{ state: 'ACTIVE', quantity: '1' }]);
  const untouched = await sql<{
    on_hand: string;
    reserved: string;
  }>`SELECT on_hand::text,reserved::text FROM inventory_batches WHERE id=${quarantine}::uuid`.execute(
    world.db.db,
  );
  expect(untouched.rows[0]).toEqual({ on_hand: '3', reserved: '0' });
});
