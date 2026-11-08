import { sql } from 'kysely';
import { uuidV7 } from '../../src/common/ids/ids.js';
import type { DatabaseHandle } from '../../src/platform/database/database.js';
import type { EventEnvelope } from '../../src/platform/outbox/outbox.js';
import type { Json } from '../../src/platform/database/database.js';

export interface PickingWorld {
  store: string;
  manager: string;
  picker1: string;
  picker2: string;
  category: string;
  product: string;
  makeVariant(input?: { barcode?: string; perishable?: boolean; bin?: string }): Promise<string>;
}

/** Minimal identity/store/catalog/inventory world for picking suites. */
export async function seedPickingWorld(db: DatabaseHandle): Promise<PickingWorld> {
  const entity = uuidV7(),
    city = uuidV7(),
    store = uuidV7(),
    manager = uuidV7(),
    picker1 = uuidV7(),
    picker2 = uuidV7(),
    category = uuidV7(),
    product = uuidV7();
  await sql`INSERT INTO legal_entities(id,name) VALUES(${entity}::uuid,'entity')`.execute(db.db);
  await sql`INSERT INTO cities(id,name,bounds) VALUES(${city}::uuid,'city',ST_GeomFromText('POLYGON((77 12,78 12,78 14,77 14,77 12))',4326))`.execute(
    db.db,
  );
  await sql`INSERT INTO stores(id,legal_entity_id,city_id,name,location,status,hourly_capacity) VALUES(${store}::uuid,${entity}::uuid,${city}::uuid,'store',ST_SetSRID(ST_MakePoint(77.6,13),4326)::geography,'ONLINE',10)`.execute(
    db.db,
  );
  const user = async (id: string, name: string, role: 'STORE_MANAGER' | 'PICKER') => {
    await sql`INSERT INTO users(id,pool,cognito_sub,normalized_email,name) VALUES(${id}::uuid,'WORKFORCE',${name},${`${name}@example.invalid`},${name})`.execute(
      db.db,
    );
    await sql`INSERT INTO user_roles(user_id,role) VALUES(${id}::uuid,${role})`.execute(db.db);
    await sql`INSERT INTO store_staff(user_id,store_id,role) VALUES(${id}::uuid,${store}::uuid,${role})`.execute(
      db.db,
    );
  };
  await user(manager, 'manager', 'STORE_MANAGER');
  await user(picker1, 'picker1', 'PICKER');
  await user(picker2, 'picker2', 'PICKER');
  await sql`INSERT INTO catalog_categories(id,name) VALUES(${category}::uuid,'Dairy')`.execute(
    db.db,
  );
  await sql`INSERT INTO catalog_products(id,category_id,name,normalized_name,published) VALUES(${product}::uuid,${category}::uuid,'Milk','milk',true)`.execute(
    db.db,
  );
  return {
    store,
    manager,
    picker1,
    picker2,
    category,
    product,
    async makeVariant(input) {
      const id = uuidV7();
      await sql`INSERT INTO catalog_variants(id,product_id,name,sku,barcode) VALUES(${id}::uuid,${product}::uuid,'Unit',${id},${input?.barcode ?? null})`.execute(
        db.db,
      );
      await sql`INSERT INTO store_inventory(store_id,variant_id,bin_location) VALUES(${store}::uuid,${id}::uuid,${input?.bin ?? null})`.execute(
        db.db,
      );
      return id;
    },
  };
}

export interface ConfirmedOrder {
  orderId: string;
  eventId: string;
  items: { orderItemId: string; variantId: string; name: string; quantity: string }[];
}

/**
 * Emits a synthetic ORDER_CONFIRMED outbox event with a picking delivery, as
 * the P6 orders module will; the caller drives the consumer over it.
 */
export async function emitOrderConfirmed(
  db: DatabaseHandle,
  world: PickingWorld,
  lines: { variantId: string; quantity: string; orderItemId?: string }[],
): Promise<ConfirmedOrder> {
  const orderId = uuidV7();
  const eventId = uuidV7();
  const customer = uuidV7();
  await sql`INSERT INTO users(id,pool,cognito_sub,normalized_email,name) VALUES(${customer}::uuid,'CUSTOMER',${customer},${`customer-${customer}@example.invalid`},'Customer')`.execute(
    db.db,
  );
  const items = lines.map((line) => ({
    orderItemId: line.orderItemId ?? uuidV7(),
    variantId: line.variantId,
    name: `item-${line.variantId}`,
    quantity: line.quantity,
  }));
  const payload: Json = {
    orderId,
    orderNumber: `ORD-${orderId.slice(0, 8)}`,
    userId: customer,
    storeId: world.store,
    targetDeliveryAt: new Date(Date.now() + 600000).toISOString(),
    items,
  };
  // 007 enforces inventory_reservations.order_id -> orders(id): the fixture
  // creates the confirmed order row its reservation references.
  const userId = customer;
  await sql`INSERT INTO orders(id,order_number,user_id,store_id,address_snapshot,status,payment_status,payment_method,subtotal_paise,discount_paise,fee_total_paise,tax_total_paise,tip_paise,total_paise,wallet_promo_paise,wallet_cash_paise,amount_due_paise,placed_at,confirmed_at) VALUES(${orderId}::uuid,${`ORD-${orderId.replaceAll('-', '').toUpperCase()}`},${userId}::uuid,${world.store}::uuid,${'{}'}::jsonb,'CONFIRMED','PAID','GATEWAY',0,0,0,0,0,0,0,0,0,clock_timestamp(),clock_timestamp())`.execute(
    db.db,
  );
  for (const item of items)
    await sql`INSERT INTO order_items(id,order_id,variant_id,name_snapshot,ordered_qty,fulfilled_qty,unit_price_paise,mrp_paise,tax_rate_bps,hsn_code,line_status) VALUES(${item.orderItemId}::uuid,${orderId}::uuid,${item.variantId}::uuid,${item.name},${item.quantity}::bigint,${item.quantity}::bigint,0,0,0,'0000','FULFILLED')`.execute(
      db.db,
    );
  await sql`INSERT INTO delivery_tasks(id,order_id,store_id,customer_user_id,status,rider_id,arrived_store_at)
    VALUES(${uuidV7()}::uuid,${orderId}::uuid,${world.store}::uuid,${customer}::uuid,'AT_STORE',${world.manager}::uuid,clock_timestamp())`.execute(
    db.db,
  );
  await sql`INSERT INTO outbox_events(id,event_type,schema_version,aggregate_type,aggregate_id,aggregate_version,correlation_id,payload) VALUES(${eventId}::uuid,'ORDER_CONFIRMED',1,'order',${orderId}::uuid,1::bigint,${orderId},${JSON.stringify(payload)}::jsonb)`.execute(
    db.db,
  );
  await sql`INSERT INTO outbox_deliveries(event_id,consumer) VALUES(${eventId}::uuid,'picking')`.execute(
    db.db,
  );
  return { orderId, eventId, items };
}

export function envelopeOf(event: {
  eventId: string;
  eventType: string;
  aggregateId: string;
  payload: unknown;
}): EventEnvelope {
  return {
    eventId: event.eventId,
    eventType: event.eventType,
    schemaVersion: 1,
    aggregateType: 'order',
    aggregateId: event.aggregateId,
    aggregateVersion: '1',
    occurredAt: new Date().toISOString(),
    correlationId: event.aggregateId,
    causationId: null,
    payload: event.payload as Json,
  };
}

/** AdminConfig fake with auto_substitution on for substitution suites. */
export function fakeAdmin(autoSubstitution = true) {
  return {
    snapshot: async () => ({
      config: new Proxy({} as never, {
        get: (_t, key) => {
          throw new Error(`unexpected config read: ${String(key)}`);
        },
      }),
      flags: {
        wallet_enabled: false,
        cod_enabled: false,
        subscriptions_enabled: false,
        auto_substitution: autoSubstitution,
        reinstate_expired_orders: false,
        surge_enabled: false,
      },
    }),
    update: async () => undefined,
    setFlag: async () => undefined,
  };
}
