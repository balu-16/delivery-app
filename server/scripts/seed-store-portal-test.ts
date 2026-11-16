import { sql } from 'kysely';
import { uuidV7 } from '../src/common/ids/ids.js';
import {
  createDatabase,
  databaseIamRegion,
  transactionWithRetry,
} from '../src/platform/database/database.js';
import type { DatabaseHandle, Json } from '../src/platform/database/database.js';
import { DatabaseIdentityAccess } from '../src/modules/identity/infrastructure/identity-access.js';
import { PostgresInventoryManagement } from '../src/modules/inventory/infrastructure/management.js';
import { PostgresReservations } from '../src/modules/inventory/infrastructure/reservations.js';
import { OrderConfirmedConsumer } from '../src/modules/picking/infrastructure/confirmation-consumer.js';
import { ConfigService } from '../src/modules/app-config/infrastructure/config-service.js';
import type { EventEnvelope } from '../src/platform/outbox/outbox.js';

/**
 * Seeds the isolated store-portal test database (delivery_test_store only —
 * the script refuses any other target). Creates two stores, two Cognito-bound
 * managers, riders/customers, catalog + stock received through the inventory
 * contract, live pick tasks through the real ORDER_CONFIRMED consumer, a
 * COD-eligible rider with cash in hand, one failed-delivery order eligible
 * for return, and inbox notifications.
 *
 * Env: DATABASE_URL (IAM delivery_runtime), STORE_MANAGER_SUB/EMAIL and
 * STORE_MANAGER2_SUB/EMAIL for the real Cognito manager identities.
 */

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required');
  const dbName = new URL(databaseUrl).pathname.replace(/^\//, '');
  if (dbName !== 'deliveryapp')
    throw new Error(
      `Refusing to seed database '${dbName}' — this seed targets the dev Aurora 'deliveryapp' only`,
    );
  const managerSub = process.env.STORE_MANAGER_SUB;
  const managerEmail = process.env.STORE_MANAGER_EMAIL;
  const manager2Sub = process.env.STORE_MANAGER2_SUB;
  const manager2Email = process.env.STORE_MANAGER2_EMAIL;
  if (!managerSub || !managerEmail || !manager2Sub || !manager2Email)
    throw new Error('STORE_MANAGER_SUB/EMAIL and STORE_MANAGER2_SUB/EMAIL are required');

  const db: DatabaseHandle = createDatabase(
    databaseUrl,
    10,
    15000,
    undefined,
    10000,
    databaseIamRegion(process.env),
  );
  const identity = new DatabaseIdentityAccess(db.db);
  const config = new ConfigService(db.db);
  const consumer = new OrderConfirmedConsumer(config);
  const inventory = new PostgresInventoryManagement(db.db, identity);
  const reservations = new PostgresReservations(db.db);

  const entity = uuidV7();
  const city = uuidV7();
  const store1 = '018f0000-0000-7000-8000-000000000001';
  const store2 = '018f0000-0000-7000-8000-000000000002';
  const managerA = uuidV7();
  const managerB = uuidV7();
  const rider1 = uuidV7();
  const rider2 = uuidV7();
  const customers = [uuidV7(), uuidV7(), uuidV7()];

  await sql`INSERT INTO legal_entities(id,name) VALUES(${entity}::uuid,'DairyDirect Test Entity')`.execute(
    db.db,
  );
  await sql`INSERT INTO cities(id,name,bounds) VALUES(${city}::uuid,'Test City',ST_GeomFromText('POLYGON((80 12,81 12,81 14,80 14,80 12))',4326))`.execute(
    db.db,
  );
  await sql`INSERT INTO stores(id,legal_entity_id,city_id,name,location,status,hourly_capacity) VALUES
    (${store1}::uuid,${entity}::uuid,${city}::uuid,'Central Test Store',ST_SetSRID(ST_MakePoint(80.1,13.1),4326)::geography,'ONLINE',20),
    (${store2}::uuid,${entity}::uuid,${city}::uuid,'South Test Store',ST_SetSRID(ST_MakePoint(80.3,12.9),4326)::geography,'ONLINE',10)`.execute(
    db.db,
  );
  for (const weekday of [0, 1, 2, 3, 4, 5, 6])
    await sql`INSERT INTO store_hours(store_id,weekday,start_minute,end_minute) VALUES
      (${store1}::uuid,${weekday},360,1200),(${store2}::uuid,${weekday},360,1200)`.execute(db.db);

  const user = async (
    id: string,
    pool: 'WORKFORCE' | 'CUSTOMER',
    sub: string,
    email: string,
    name: string,
  ) => {
    await sql`INSERT INTO users(id,pool,cognito_sub,normalized_email,name,email_verified)
      VALUES(${id}::uuid,${pool},${sub},${email.toLowerCase()},${name},true)`.execute(db.db);
    return id;
  };
  await user(managerA, 'WORKFORCE', managerSub, managerEmail, 'Test Manager A');
  await user(managerB, 'WORKFORCE', manager2Sub, manager2Email, 'Test Manager B');
  await sql`INSERT INTO user_roles(user_id,role) VALUES
    (${managerA}::uuid,'STORE_MANAGER'),(${managerB}::uuid,'STORE_MANAGER')`.execute(db.db);
  await sql`INSERT INTO store_staff(user_id,store_id,role) VALUES
    (${managerA}::uuid,${store1}::uuid,'STORE_MANAGER'),
    (${managerA}::uuid,${store2}::uuid,'STORE_MANAGER'),
    (${managerB}::uuid,${store2}::uuid,'STORE_MANAGER')`.execute(db.db);
  await user(rider1, 'WORKFORCE', `seed-rider-${rider1}`, 'rider1@storetest.invalid', 'Ravi Rider');
  await user(rider2, 'WORKFORCE', `seed-rider-${rider2}`, 'rider2@storetest.invalid', 'Rhea Rider');
  await sql`INSERT INTO user_roles(user_id,role) VALUES
    (${rider1}::uuid,'RIDER'),(${rider2}::uuid,'RIDER')`.execute(db.db);
  await sql`INSERT INTO rider_profiles(user_id,status,vehicle_type,vehicle_no,home_store_id) VALUES
    (${rider1}::uuid,'APPROVED','BIKE','TS01RD1001',${store1}::uuid),
    (${rider2}::uuid,'APPROVED','BIKE','TS01RD1002',${store2}::uuid)`.execute(db.db);
  const customerNames = ['Asha Customer', 'Bharat Customer', 'Chandra Customer'];
  for (const [n, id] of customers.entries())
    await user(
      id,
      'CUSTOMER',
      `seed-customer-${id}`,
      `customer${n + 1}@storetest.invalid`,
      customerNames[n]!,
    );

  const category = uuidV7();
  await sql`INSERT INTO catalog_categories(id,name) VALUES(${category}::uuid,'Test Dairy')`.execute(
    db.db,
  );
  const products = [
    { name: 'Test full-cream milk', pack: '500 ml', price: '3500' },
    { name: 'Test toned milk', pack: '500 ml', price: '3000' },
    { name: 'Test curd', pack: '400 g', price: '4500' },
    { name: 'Test paneer', pack: '200 g', price: '9000' },
  ];
  const variants: {
    id: string;
    barcode: string;
    name: string;
    price: string;
    perishable: boolean;
  }[] = [];
  for (const [n, product] of products.entries()) {
    const productId = uuidV7();
    const variantId = uuidV7();
    const perishable = n < 3;
    await sql`INSERT INTO catalog_products(id,category_id,name,normalized_name,published,perishable,expiry_tracking)
      VALUES(${productId}::uuid,${category}::uuid,${product.name},${product.name.toLowerCase()},true,${perishable},${perishable})`.execute(
      db.db,
    );
    await sql`INSERT INTO catalog_variants(id,product_id,name,sku,barcode)
      VALUES(${variantId}::uuid,${productId}::uuid,${product.pack},${`DD-STORE-00${n + 1}`},${`89012345000${n + 1}`})`.execute(
      db.db,
    );
    for (const store of [store1, store2])
      await sql`INSERT INTO store_inventory(store_id,variant_id,bin_location)
        VALUES(${store}::uuid,${variantId}::uuid,${`A${n + 1}`})`.execute(db.db);
    variants.push({
      id: variantId,
      barcode: `89012345000${n + 1}`,
      name: `${product.name} ${product.pack}`,
      price: product.price,
      perishable,
    });
  }

  // Stock through the real receive contract (manager actor, batch + ledger).
  // Paneer is deliberately low (low-stock alert); curd gets a near-expiry batch.
  for (const variant of variants) {
    const onHand = variant.name.startsWith('Test paneer') ? '5' : '120';
    for (const store of [store1, store2]) {
      await inventory.receive(managerA, {
        storeId: store,
        variantId: variant.id,
        batchCode: `B-STORE-${variant.barcode.slice(-1)}-${store.slice(-2)}`,
        quantity: onHand,
        expiresAt: variant.perishable
          ? new Date(
              Date.now() + (variant.name.startsWith('Test curd') ? 36 : 10 * 24) * 3600 * 1000,
            ).toISOString()
          : null,
        reference: uuidV7(),
      });
    }
  }

  interface SeededOrder {
    orderId: string;
    lines: { variantId: string; quantity: string }[];
  }
  const insertConfirmedOrder = async (
    customerIdx: number,
    lines: { variantId: string; quantity: string }[],
  ): Promise<{ orderId: string; eventId: string }> => {
    const orderId = uuidV7();
    const eventId = uuidV7();
    const customer = customers[customerIdx]!;
    const items = lines.map((line) => ({
      orderItemId: uuidV7(),
      variantId: line.variantId,
      name: variants.find((v) => v.id === line.variantId)?.name ?? 'item',
      quantity: line.quantity,
    }));
    await sql`INSERT INTO orders(id,order_number,user_id,store_id,address_snapshot,status,payment_status,payment_method,subtotal_paise,discount_paise,fee_total_paise,tax_total_paise,tip_paise,total_paise,wallet_promo_paise,wallet_cash_paise,amount_due_paise,placed_at,confirmed_at)
      VALUES(${orderId}::uuid,${`ORD-${orderId.replaceAll('-', '').slice(0, 10).toUpperCase()}`},${customer}::uuid,${store1}::uuid,${'{"line1":"Test Street"}'}::jsonb,'CONFIRMED','PAID',${customerIdx % 2 ? 'COD' : 'GATEWAY'},${String(lines.length * 3500)},0,0,0,0,${String(lines.length * 3500)},0,0,${String(lines.length * 3500)},clock_timestamp() - interval '20 minutes',clock_timestamp() - interval '19 minutes')`.execute(
      db.db,
    );
    for (const item of items)
      await sql`INSERT INTO order_items(id,order_id,variant_id,name_snapshot,ordered_qty,fulfilled_qty,unit_price_paise,mrp_paise,tax_rate_bps,hsn_code,line_status)
        VALUES(${item.orderItemId}::uuid,${orderId}::uuid,${item.variantId}::uuid,${item.name},${item.quantity}::bigint,${item.quantity}::bigint,3500,3500,0,'0401','FULFILLED')`.execute(
        db.db,
      );
    await sql`INSERT INTO delivery_tasks(id,order_id,store_id,customer_user_id,status,rider_id,arrived_store_at)
      VALUES(${uuidV7()}::uuid,${orderId}::uuid,${store1}::uuid,${customer}::uuid,'AT_STORE',${rider1}::uuid,clock_timestamp())`.execute(
      db.db,
    );
    const payload: Json = {
      orderId,
      orderNumber: `ORD-${orderId.replaceAll('-', '').slice(0, 10).toUpperCase()}`,
      userId: customer,
      storeId: store1,
      targetDeliveryAt: new Date(Date.now() + 45 * 60000).toISOString(),
      items: items.map((item) => ({
        orderItemId: item.orderItemId,
        variantId: item.variantId,
        name: item.name,
        quantity: item.quantity,
      })),
    };
    await sql`INSERT INTO outbox_events(id,event_type,schema_version,aggregate_type,aggregate_id,aggregate_version,correlation_id,payload)
      VALUES(${eventId}::uuid,'ORDER_CONFIRMED',1,'order',${orderId}::uuid,1::bigint,${orderId},${JSON.stringify(payload)}::jsonb)`.execute(
      db.db,
    );
    return { orderId, eventId };
  };

  // Three live orders → real pick tasks via the domain consumer, stock
  // reserved + committed so barcodes/FEFO resolve during picking.
  const confirmedOrders: SeededOrder[] = [];
  for (const [idx, lines] of [
    [
      { variantId: variants[0]!.id, quantity: '2' },
      { variantId: variants[1]!.id, quantity: '1' },
    ],
    [{ variantId: variants[2]!.id, quantity: '3' }],
    [
      { variantId: variants[0]!.id, quantity: '1' },
      { variantId: variants[3]!.id, quantity: '1' },
    ],
  ].entries()) {
    const { orderId, eventId } = await insertConfirmedOrder(
      idx,
      lines as { variantId: string; quantity: string }[],
    );
    const events = await sql<{ id: string; payload: Json }>`SELECT id,payload FROM outbox_events
      WHERE id=${eventId}::uuid`.execute(db.db);
    const row = events.rows[0]!;
    const envelope: EventEnvelope = {
      eventId: row.id,
      eventType: 'ORDER_CONFIRMED',
      schemaVersion: 1,
      aggregateType: 'order',
      aggregateId: orderId,
      aggregateVersion: '1',
      occurredAt: new Date().toISOString(),
      correlationId: orderId,
      causationId: null,
      payload: row.payload,
    };
    await transactionWithRetry(db.db, async (tx) => {
      await consumer.handle(tx, envelope);
      await sql`INSERT INTO outbox_deliveries(event_id,consumer) VALUES(${row.id}::uuid,'picking')`.execute(
        tx,
      );
    });
    await reservations.reserve({
      orderId,
      lines: (lines as { variantId: string; quantity: string }[]).map((line) => ({
        storeId: store1,
        variantId: line.variantId,
        quantity: line.quantity,
      })),
      targetDeliveryAt: new Date(Date.now() + 45 * 60000).toISOString(),
      ttlSeconds: 6 * 3600,
    });
    await reservations.commit(orderId);
    confirmedOrders.push({ orderId, lines: lines as { variantId: string; quantity: string }[] });
  }

  // One delivered COD order with rider cash in hand (COD deposit eligible).
  const codOrder = uuidV7();
  await sql`INSERT INTO orders(id,order_number,user_id,store_id,address_snapshot,status,payment_status,payment_method,subtotal_paise,discount_paise,fee_total_paise,tax_total_paise,tip_paise,total_paise,wallet_promo_paise,wallet_cash_paise,amount_due_paise,placed_at,confirmed_at,delivered_at)
    VALUES(${codOrder}::uuid,'ORD-COD-TEST-1',${customers[0]!}::uuid,${store1}::uuid,'{"line1":"Test Street"}'::jsonb,'DELIVERED','COD_COLLECTED','COD','7000',0,0,0,0,'7000',0,0,'7000',clock_timestamp() - interval '2 hours',clock_timestamp() - interval '2 hours',clock_timestamp() - interval '1 hour')`.execute(
    db.db,
  );
  await sql`INSERT INTO order_items(id,order_id,variant_id,name_snapshot,ordered_qty,fulfilled_qty,unit_price_paise,mrp_paise,tax_rate_bps,hsn_code,line_status)
    VALUES(${uuidV7()}::uuid,${codOrder}::uuid,${variants[0]!.id}::uuid,'Test full-cream milk 500 ml','2','2',3500,3500,0,'0401','FULFILLED')`.execute(
    db.db,
  );
  await sql`INSERT INTO delivery_tasks(id,order_id,store_id,customer_user_id,status,rider_id,pickup_at,arrived_store_at,arrived_customer_at,delivered_at)
    VALUES(${uuidV7()}::uuid,${codOrder}::uuid,${store1}::uuid,${customers[0]!}::uuid,'DELIVERED',${rider1}::uuid,clock_timestamp() - interval '90 minutes',clock_timestamp() - interval '2 hours',clock_timestamp() - interval '70 minutes',clock_timestamp() - interval '1 hour')`.execute(
    db.db,
  );
  await sql`INSERT INTO rider_cash_ledger(id,rider_id,delta_paise,reason,ref_type,ref_id,balance_after)
    VALUES(${uuidV7()}::uuid,${rider1}::uuid,7000,'COD_COLLECTED','ORDER',${codOrder}::uuid,7000)`.execute(
    db.db,
  );

  // One failed-delivery order → eligible for return recording.
  const failedOrder = uuidV7();
  await sql`INSERT INTO orders(id,order_number,user_id,store_id,address_snapshot,status,payment_status,payment_method,subtotal_paise,discount_paise,fee_total_paise,tax_total_paise,tip_paise,total_paise,wallet_promo_paise,wallet_cash_paise,amount_due_paise,placed_at,confirmed_at)
    VALUES(${failedOrder}::uuid,'ORD-RTO-TEST-1',${customers[1]!}::uuid,${store1}::uuid,'{"line1":"Test Street"}'::jsonb,'DELIVERY_FAILED','COD_PENDING','COD','6000',0,0,0,0,'6000',0,0,6000,clock_timestamp() - interval '3 hours',clock_timestamp() - interval '3 hours')`.execute(
    db.db,
  );
  await sql`INSERT INTO order_items(id,order_id,variant_id,name_snapshot,ordered_qty,fulfilled_qty,unit_price_paise,mrp_paise,tax_rate_bps,hsn_code,line_status)
    VALUES(${uuidV7()}::uuid,${failedOrder}::uuid,${variants[1]!.id}::uuid,'Test toned milk 500 ml','2','2',3000,3000,0,'0401','FULFILLED'),
      (${uuidV7()}::uuid,${failedOrder}::uuid,${variants[2]!.id}::uuid,'Test curd 400 g','1','1',4500,4500,0,'0401','FULFILLED')`.execute(
    db.db,
  );
  await sql`INSERT INTO delivery_tasks(id,order_id,store_id,customer_user_id,status,rider_id,failure_reason)
    VALUES(${uuidV7()}::uuid,${failedOrder}::uuid,${store1}::uuid,${customers[1]!}::uuid,'FAILED',${rider2}::uuid,'CUSTOMER_UNAVAILABLE')`.execute(
    db.db,
  );

  // Status history for the store status view + inbox notifications (some unread).
  await sql`INSERT INTO store_status_history(store_id,version,previous_status,status,reason,actor_id)
    VALUES(${store1}::uuid,1,'OFFLINE','ONLINE',NULL,${managerA}::uuid),
      (${store1}::uuid,2,'ONLINE','PAUSED','Seeded test pause',${managerA}::uuid),
      (${store1}::uuid,3,'PAUSED','ONLINE',NULL,${managerA}::uuid)`.execute(db.db);
  const notifications: [string, boolean][] = [
    ['store_order_arrived', false],
    ['picking_sla_warning', false],
    ['inventory_low_stock', true],
    ['cod_deposit_received', true],
  ];
  for (const [n, [template, read]] of notifications.entries())
    await sql`INSERT INTO notifications(id,user_id,channel,template_key,locale,category,class,payload,status,dedupe_key,read_at)
      VALUES(${uuidV7()}::uuid,${managerA}::uuid,'INBOX',${template},'en','STORE_OPS','TRANSACTIONAL',
        ${JSON.stringify({ storeId: store1, body: `Seeded test notification ${n + 1}` })}::jsonb,'SENT',${`seed-${n}-${template}`},${read ? sql`clock_timestamp() - interval '30 minutes'` : sql`NULL`})`.execute(
      db.db,
    );

  const counts = await sql<{ pick_tasks: string; batches: string; orders: string }>`SELECT
    (SELECT count(*) FROM pick_tasks)::text AS pick_tasks,
    (SELECT count(*) FROM inventory_batches)::text AS batches,
    (SELECT count(*) FROM orders)::text AS orders`.execute(db.db);
  console.log(
    JSON.stringify(
      {
        seeded: true,
        stores: [store1, store2],
        managerA: { id: managerA, email: managerEmail, sub: managerSub },
        managerB: { id: managerB, email: manager2Email, sub: manager2Sub },
        riders: [rider1, rider2],
        counts: counts.rows[0],
        orders: confirmedOrders,
        failedOrder,
        variants: variants.map((v) => ({ id: v.id, barcode: v.barcode, name: v.name })),
      },
      null,
      1,
    ),
  );
  await db.close();
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : error);
  process.exitCode = 1;
});
