import { sql } from 'kysely';
import { uuidV7 } from '../../src/common/ids/ids.js';
import { consumeOnce } from '../../src/platform/events/consume.js';
import type {
  DatabaseHandle,
  Json,
  TransactionContext,
} from '../../src/platform/database/database.js';
import type { EventEnvelope } from '../../src/platform/outbox/outbox.js';

export interface NotificationsWorld {
  store: string;
  manager: string;
  admin: string;
  customer: string;
  customerTe: string;
  other: string;
}

/** Minimal identity/store world: one store manager, one admin, customers. */
export async function seedNotificationsWorld(db: DatabaseHandle): Promise<NotificationsWorld> {
  const store = uuidV7(),
    manager = uuidV7(),
    admin = uuidV7(),
    customer = uuidV7(),
    customerTe = uuidV7(),
    other = uuidV7();
  const user = async (id: string, pool: 'CUSTOMER' | 'WORKFORCE', name: string) => {
    await sql`INSERT INTO users(id,pool,cognito_sub,normalized_email,name) VALUES(${id}::uuid,${pool},${name},${`${name}@notifications.invalid`},${name})`.execute(
      db.db,
    );
  };
  await user(manager, 'WORKFORCE', 'notify-manager');
  await sql`INSERT INTO user_roles(user_id,role) VALUES(${manager}::uuid,'STORE_MANAGER')`.execute(
    db.db,
  );
  await user(admin, 'WORKFORCE', 'notify-admin');
  await sql`INSERT INTO user_roles(user_id,role) VALUES(${admin}::uuid,'ADMIN')`.execute(db.db);
  // Distinct names: uuidV7 shares a time prefix within one millisecond.
  const names = ['notify-cust', 'notify-cust-te', 'notify-other'];
  for (const [index, id] of [customer, customerTe, other].entries())
    await user(id, 'CUSTOMER', names[index]!);
  await sql`INSERT INTO customer_profiles(user_id,locale) VALUES(${customerTe}::uuid,'te')`.execute(
    db.db,
  );
  const entity = uuidV7(),
    city = uuidV7();
  await sql`INSERT INTO legal_entities(id,name) VALUES(${entity}::uuid,'entity')`.execute(db.db);
  await sql`INSERT INTO cities(id,name,bounds) VALUES(${city}::uuid,'city',ST_GeomFromText('POLYGON((77 12,78 12,78 14,77 14,77 12))',4326))`.execute(
    db.db,
  );
  await sql`INSERT INTO stores(id,legal_entity_id,city_id,name,location,status,hourly_capacity) VALUES(${store}::uuid,${entity}::uuid,${city}::uuid,'notify-store',ST_SetSRID(ST_MakePoint(77.6,13),4326)::geography,'ONLINE',10)`.execute(
    db.db,
  );
  await sql`INSERT INTO store_staff(user_id,store_id,role) VALUES(${manager}::uuid,${store}::uuid,'STORE_MANAGER')`.execute(
    db.db,
  );
  return { store, manager, admin, customer, customerTe, other };
}

export interface EmittedEvent {
  eventId: string;
  eventType: string;
  aggregateId: string;
  aggregateVersion: string;
  schemaVersion: number;
  payload: Json;
}

/** Emits a synthetic outbox event with a notifications delivery (ADR 0011). */
export async function emitNotificationEvent(
  db: DatabaseHandle,
  input: {
    eventType: string;
    aggregateId?: string;
    aggregateVersion?: string;
    aggregateType?: string;
    schemaVersion?: number;
    payload: Json;
    consumers?: readonly string[];
  },
): Promise<EmittedEvent> {
  const eventId = uuidV7();
  const aggregateId = input.aggregateId ?? uuidV7();
  const version = input.aggregateVersion ?? '1';
  await sql`INSERT INTO outbox_events(id,event_type,schema_version,aggregate_type,aggregate_id,aggregate_version,correlation_id,payload) VALUES(${eventId}::uuid,${input.eventType},${input.schemaVersion ?? 1},${input.aggregateType ?? 'order'},${aggregateId}::uuid,${version}::bigint,${aggregateId},${JSON.stringify(input.payload)}::jsonb)`.execute(
    db.db,
  );
  for (const consumer of input.consumers ?? ['notifications'])
    await sql`INSERT INTO outbox_deliveries(event_id,consumer) VALUES(${eventId}::uuid,${consumer})`.execute(
      db.db,
    );
  return {
    eventId,
    eventType: input.eventType,
    aggregateId,
    aggregateVersion: version,
    schemaVersion: input.schemaVersion ?? 1,
    payload: input.payload,
  };
}

export function envelopeOf(emit: EmittedEvent): EventEnvelope {
  return {
    eventId: emit.eventId,
    eventType: emit.eventType,
    schemaVersion: emit.schemaVersion,
    aggregateType: 'order',
    aggregateId: emit.aggregateId,
    aggregateVersion: emit.aggregateVersion,
    occurredAt: new Date().toISOString(),
    correlationId: emit.aggregateId,
    causationId: null,
    payload: emit.payload,
  };
}

/** Runs the pipeline consumer over the emitted event exactly like the relay. */
export async function consumeEvent(
  db: DatabaseHandle,
  pipeline: { consume: (tx: TransactionContext, event: EventEnvelope) => Promise<void> },
  emit: EmittedEvent,
): Promise<boolean> {
  return consumeOnce(db.db, emit.eventId, 'notifications', async (tx) =>
    pipeline.consume(tx, envelopeOf(emit)),
  );
}

/** Direct inbox row seed for pagination/read tests (bypasses the pipeline). */
export async function seedInboxRow(
  db: DatabaseHandle,
  input: {
    userId: string;
    dedupeKey: string;
    createdAt?: Date;
    status?: string;
    channel?: string;
    templateKey?: string;
  },
): Promise<string> {
  const id = uuidV7();
  await sql`INSERT INTO notifications(id,user_id,channel,template_key,locale,category,class,payload,status,dedupe_key,created_at) VALUES(${id}::uuid,${input.userId}::uuid,${input.channel ?? 'INBOX'},${input.templateKey ?? 'order.confirmed'},'en','ORDER_UPDATES','TRANSACTIONAL','{}'::jsonb,${input.status ?? 'SENT'},${input.dedupeKey},${(input.createdAt ?? new Date()).toISOString()}::timestamptz)`.execute(
    db.db,
  );
  return id;
}

export async function notificationCount(db: DatabaseHandle, userId: string): Promise<number> {
  const rows = await sql<{
    count: string;
  }>`SELECT count(*)::text AS count FROM notifications WHERE user_id=${userId}::uuid`.execute(
    db.db,
  );
  return Number(rows.rows[0]?.count ?? '0');
}
