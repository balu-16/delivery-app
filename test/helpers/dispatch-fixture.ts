import { DISPATCH_CONFIG_DEFAULTS } from '../../src/modules/dispatch/domain/settings.js';
import { RIDER_CONFIG_DEFAULTS } from '../../src/modules/riders/domain/defaults.js';
import { TRACKING_CONFIG_DEFAULTS } from '../../src/modules/tracking/domain/eta.js';
import { sql } from 'kysely';
import { uuidV7 } from '../../src/common/ids/ids.js';
import type { DatabaseHandle, Json } from '../../src/platform/database/database.js';
import type { EventEnvelope } from '../../src/platform/outbox/outbox.js';
import type { AppConfig } from '../../src/modules/app-config/contracts/config.js';

export interface DispatchWorld {
  store: string;
  storeLat: number;
  storeLng: number;
  customer: string;
  manager: string;
  rider1: string;
  rider2: string;
  rider3: string;
}

/**
 * Minimal identity/store/rider world for dispatch suites: three APPROVED
 * riders with fresh online status near the store, one customer, one store
 * manager (handover verification).
 */
export async function seedDispatchWorld(db: DatabaseHandle): Promise<DispatchWorld> {
  const store = uuidV7();
  const entity = uuidV7();
  const city = uuidV7();
  const customer = uuidV7();
  const manager = uuidV7();
  const riders = [uuidV7(), uuidV7(), uuidV7()];
  const storeLat = 12.9;
  const storeLng = 77.6;
  await sql`INSERT INTO users(id,pool,cognito_sub,normalized_email,name) VALUES
    (${customer}::uuid,'CUSTOMER',${customer},${'customer@example.invalid'},'customer')`.execute(
    db.db,
  );
  await sql`INSERT INTO customer_profiles(user_id) VALUES(${customer}::uuid)`.execute(db.db);
  await sql`INSERT INTO users(id,pool,cognito_sub,normalized_email,name) VALUES(${manager}::uuid,'WORKFORCE',${manager},${'manager@example.invalid'},'manager')`.execute(
    db.db,
  );
  await sql`INSERT INTO user_roles(user_id,role) VALUES(${manager}::uuid,'STORE_MANAGER')`.execute(
    db.db,
  );
  for (const [index, rider] of riders.entries()) {
    await sql`INSERT INTO users(id,pool,cognito_sub,normalized_email,name) VALUES(${rider}::uuid,'WORKFORCE',${rider},${`rider${index}@example.invalid`},${`rider${index}`})`.execute(
      db.db,
    );
    await sql`INSERT INTO user_roles(user_id,role) VALUES(${rider}::uuid,'RIDER')`.execute(db.db);
    await sql`INSERT INTO rider_profiles(user_id,status,vehicle_type,vehicle_no) VALUES(${rider}::uuid,'APPROVED','SCOOTER',${'KA-0' + index})`.execute(
      db.db,
    );
    // Riders sit within ~200 m of the store; fresh locations, online, idle.
    await sql`INSERT INTO rider_status(rider_id,online,last_heartbeat_at,last_location,last_location_at,last_location_source,active_tasks,idle_since)
      VALUES(${rider}::uuid,true,clock_timestamp(),
        ST_SetSRID(ST_MakePoint(${storeLng + 0.0005 * (index + 1)}, ${storeLat}),4326)::geography,
        clock_timestamp() - interval '5 seconds','GPS',0,clock_timestamp() - interval '10 minutes')`.execute(
      db.db,
    );
  }
  await sql`INSERT INTO legal_entities(id,name) VALUES(${entity}::uuid,'entity')`.execute(db.db);
  await sql`INSERT INTO cities(id,name,bounds) VALUES(${city}::uuid,'city',ST_GeomFromText('POLYGON((77 12,78 12,78 14,77 14,77 12))',4326))`.execute(
    db.db,
  );
  await sql`INSERT INTO stores(id,legal_entity_id,city_id,name,location,status,hourly_capacity)
    VALUES(${store}::uuid,${entity}::uuid,${city}::uuid,'store',ST_SetSRID(ST_MakePoint(${storeLng},${storeLat}),4326)::geography,'ONLINE',10)`.execute(
    db.db,
  );
  await sql`INSERT INTO store_staff(user_id,store_id,role) VALUES(${manager}::uuid,${store}::uuid,'STORE_MANAGER')`.execute(
    db.db,
  );
  return {
    store,
    storeLat,
    storeLng,
    customer,
    manager,
    rider1: riders[0]!,
    rider2: riders[1]!,
    rider3: riders[2]!,
  };
}

export interface ConfirmedOrder {
  orderId: string;
  eventId: string;
  paymentMethod: 'COD' | 'GATEWAY';
  amountDuePaise: string;
  tipPaise: string;
  destination: { lat: number; lng: number };
}

/**
 * Inserts a frozen order row (007 shape) and emits a synthetic
 * ORDER_CONFIRMED outbox event with a 'dispatch' delivery, as the P6 orders
 * module will.
 */
export async function emitConfirmedOrder(
  db: DatabaseHandle,
  world: DispatchWorld,
  options: {
    cod?: boolean;
    amountDuePaise?: string;
    destination?: { lat: number; lng: number };
  } = {},
): Promise<ConfirmedOrder> {
  const orderId = uuidV7();
  const eventId = uuidV7();
  const paymentMethod = options.cod ? 'COD' : 'GATEWAY';
  // Frozen totals reconcile: 45000 subtotal - 0 + 0 fees + 2000 tip.
  const amountDuePaise = options.amountDuePaise ?? '47000';
  const destination = options.destination ?? {
    lat: world.storeLat + 0.01,
    lng: world.storeLng + 0.01,
  };
  const address: Json = {
    line1: '221B Baker Street',
    contactName: 'Test Customer',
    contactPhone: '+919876543210',
    lat: destination.lat,
    lng: destination.lng,
  };
  await sql`INSERT INTO orders(id,order_number,user_id,store_id,address_snapshot,status,payment_status,payment_method,currency,subtotal_paise,total_paise,amount_due_paise,tip_paise,placed_at,confirmed_at)
    VALUES(${orderId}::uuid,${('ORD-' + orderId.replaceAll('-', '').slice(-12)).toUpperCase()},${world.customer}::uuid,${world.store}::uuid,${JSON.stringify(address)}::jsonb,'CONFIRMED','UNPAID',${paymentMethod},'INR',45000,47000,${amountDuePaise},2000,clock_timestamp(),clock_timestamp())`.execute(
    db.db,
  );
  if (options.cod) {
    await sql`INSERT INTO cod_collections(id,order_id,amount_paise,state) VALUES(${uuidV7()}::uuid,${orderId}::uuid,${amountDuePaise},'PENDING')`.execute(
      db.db,
    );
  }
  const payload: Json = {
    orderId,
    orderNumber: `ORD-${orderId.replaceAll('-', '').slice(-12)}`.toUpperCase(),
    userId: world.customer,
    storeId: world.store,
    targetDeliveryAt: new Date(Date.now() + 900000).toISOString(),
    items: [],
  };
  await sql`INSERT INTO outbox_events(id,event_type,schema_version,aggregate_type,aggregate_id,aggregate_version,correlation_id,payload)
    VALUES(${eventId}::uuid,'ORDER_CONFIRMED',1,'order',${orderId}::uuid,1::bigint,${orderId},${JSON.stringify(payload)}::jsonb)`.execute(
    db.db,
  );
  await sql`INSERT INTO outbox_deliveries(event_id,consumer) VALUES(${eventId}::uuid,'dispatch')`.execute(
    db.db,
  );
  return { orderId, eventId, paymentMethod, amountDuePaise, tipPaise: '2000', destination };
}

/** Simulates the P7 pack+handover prerequisite so custody tests can pick up. */
export async function packOrderForHandover(
  db: DatabaseHandle,
  world: DispatchWorld,
  orderId: string,
): Promise<void> {
  const pickTask = uuidV7();
  await sql`INSERT INTO pick_tasks(id,order_id,store_id,status,sla_due_at,completed_at,completed_by)
    VALUES(${pickTask}::uuid,${orderId}::uuid,${world.store}::uuid,'COMPLETED',clock_timestamp() + interval '30 minutes',clock_timestamp(),${world.manager}::uuid)`.execute(
    db.db,
  );
  await sql`INSERT INTO packing_records(order_id,task_id,store_id,bags,seal_code,cold_chain,packed_by)
    VALUES(${orderId}::uuid,${pickTask}::uuid,${world.store}::uuid,1,'SEAL-1',false,${world.manager}::uuid)`.execute(
    db.db,
  );
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

/**
 * Optimistic config fake: P8 settings read by name and fall back to local
 * defaults when a key is absent, so a sparse map is enough here.
 */
export function fakeConfig(values: Record<string, unknown> = {}): AppConfig {
  // mapFallbackSpeedKph is a published ConfigValues key; P8-only keys stay
  // absent so the optimistic fallback path is exercised too.
  const merged: Record<string, unknown> = {
    ...DISPATCH_CONFIG_DEFAULTS,
    ...RIDER_CONFIG_DEFAULTS,
    ...TRACKING_CONFIG_DEFAULTS,
    riderMaxConcurrentTasks: 2,
    mapFallbackSpeedKph: 20,
    mapMatrixTopK: 5,
    handoverMaxAttempts: 5,
    handoverLockoutSeconds: 300,
    ...values,
  };
  return {
    get: (async (key: string) => {
      if (key in merged) return merged[key];
      throw new Error('UNKNOWN_CONFIG_KEY');
    }) as unknown as AppConfig['get'],
  };
}

/** Broadcast recorder standing in for the realtime gateway. */
export class BroadcastRecorder {
  readonly events: { room: string; event: string; payload: unknown }[] = [];
  emitRiderEvent(riderId: string, event: string, payload: unknown): void {
    this.events.push({ room: `rider:${riderId}`, event, payload });
  }
  emitOrderEvent(orderId: string, event: string, payload: unknown): void {
    this.events.push({ room: `order:${orderId}`, event, payload });
  }
  emitOrderLocation(orderId: string, payload: unknown): void {
    this.events.push({ room: `order:${orderId}`, event: 'rider.location', payload });
  }
  ofRoom(room: string): { event: string }[] {
    return this.events
      .filter((entry) => entry.room === room)
      .map((entry) => ({ event: entry.event }));
  }
  clear(): void {
    this.events.length = 0;
  }
}
