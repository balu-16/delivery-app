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
  await sql`INSERT INTO legal_entities(id,name) VALUES(${entity}::uuid,'entity')`.execute(db.db);
  await sql`INSERT INTO cities(id,name,bounds) VALUES(${city}::uuid,'city',ST_GeomFromText('POLYGON((77 12,78 12,78 14,77 14,77 12))',4326))`.execute(
    db.db,
  );
  await sql`INSERT INTO stores(id,legal_entity_id,city_id,name,location,status,hourly_capacity) VALUES(${store}::uuid,${entity}::uuid,${city}::uuid,'store',ST_SetSRID(ST_MakePoint(77.6,13),4326)::geography,'ONLINE',10)`.execute(
    db.db,
  );
  await sql`INSERT INTO catalog_categories(id,name) VALUES(${category}::uuid,'Dairy')`.execute(
    db.db,
  );
  await sql`INSERT INTO catalog_products(id,category_id,name,normalized_name) VALUES(${product}::uuid,${category}::uuid,'Milk','milk')`.execute(
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
  const items = lines.map((line) => ({
    orderItemId: line.orderItemId ?? uuidV7(),
    variantId: line.variantId,
    name: `item-${line.variantId.slice(0, 8)}`,
    quantity: line.quantity,
  }));
  const payload: Json = {
    orderId,
    orderNumber: `ORD-${orderId.slice(0, 8)}`,
    userId: uuidV7(),
    storeId: world.store,
    targetDeliveryAt: new Date(Date.now() + 600000).toISOString(),
    items,
  };
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
