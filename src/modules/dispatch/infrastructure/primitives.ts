import { createHash } from 'node:crypto';
import { sql } from 'kysely';
import { uuidV7 } from '../../../common/ids/ids.js';
import type { Database, TransactionContext } from '../../../platform/database/database.js';
import type { DeliveryTaskStatus } from '../contracts/tasks.js';

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, canonical(v)]),
    );
  return value;
}

export function fingerprint(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex');
}

/** Module-local operation dedupe; mismatched replay input is a hard error. */
export async function operation(
  tx: TransactionContext,
  reference: string,
  kind: string,
  input: unknown,
): Promise<boolean> {
  if (!reference || reference.length > 300) throw new Error('INVALID_INPUT');
  const hash = fingerprint(input);
  const inserted =
    await sql`INSERT INTO dispatch_operations(reference,kind,request_hash) VALUES(${reference},${kind},${hash}) ON CONFLICT DO NOTHING RETURNING reference`.execute(
      tx,
    );
  if (inserted.rows.length) return true;
  const old = await sql<{
    kind: string;
    request_hash: string;
  }>`SELECT kind,request_hash FROM dispatch_operations WHERE reference=${reference}`.execute(tx);
  if (old.rows[0]?.kind !== kind || old.rows[0]?.request_hash !== hash)
    throw new Error('IDEMPOTENCY_KEY_REUSED');
  return false;
}

/** State history row with the task's next version (SYS-08). */
export async function taskHistory(
  tx: TransactionContext,
  taskId: string,
  previousStatus: DeliveryTaskStatus | null,
  status: DeliveryTaskStatus,
  actorId: string | null,
  reason?: string,
): Promise<void> {
  await sql`INSERT INTO delivery_task_history(id,task_id,version,previous_status,status,actor_id,reason)
    VALUES(${uuidV7()}::uuid,${taskId}::uuid,(SELECT COALESCE(max(version),0)+1 FROM delivery_task_history WHERE task_id=${taskId}::uuid),${previousStatus},${status},${actorId}::uuid,${reason ?? null})`.execute(
    tx,
  );
}

export async function assignmentHistory(
  tx: TransactionContext,
  taskId: string,
  attemptNo: number,
  riderId: string | null,
  action: 'ASSIGNED' | 'REASSIGNED' | 'UNASSIGNED' | 'SYSTEM_UNASSIGNED' | 'ESCALATED',
  actorId: string | null,
  reason?: string,
): Promise<void> {
  await sql`INSERT INTO task_assignment_history(id,task_id,attempt_no,rider_id,action,actor_id,reason)
    VALUES(${uuidV7()}::uuid,${taskId}::uuid,${attemptNo},${riderId}::uuid,${action},${actorId}::uuid,${reason ?? null})`.execute(
    tx,
  );
}

/** Aggregate-scoped change event; consumers create durable delivery obligations.
 * The version continues past both history rows and previously emitted events
 * (alerts carry no history), keeping the outbox unique key collision-free. */
export async function taskEvent(
  tx: TransactionContext,
  taskId: string,
  orderId: string,
  eventType: string,
  payload: Record<string, unknown>,
  consumers: readonly string[] = [],
): Promise<void> {
  const version = await sql<{ v: string }>`SELECT GREATEST(
      (SELECT COALESCE(max(version),0) FROM delivery_task_history WHERE task_id=${taskId}::uuid),
      (SELECT COALESCE(max(aggregate_version),0) FROM outbox_events WHERE aggregate_type='delivery_task' AND aggregate_id=${taskId}::uuid)
    ) + 1 AS v`.execute(tx);
  const eventId = uuidV7();
  await sql`INSERT INTO outbox_events(id,event_type,schema_version,aggregate_type,aggregate_id,aggregate_version,correlation_id,payload)
    VALUES(${eventId}::uuid,${eventType},1,'delivery_task',${taskId}::uuid,${version.rows[0]!.v}::bigint,${orderId},${JSON.stringify({ taskId, orderId, ...payload })}::jsonb)`.execute(
    tx,
  );
  for (const consumer of consumers)
    await sql`INSERT INTO outbox_deliveries(event_id,consumer) VALUES(${eventId}::uuid,${consumer})`.execute(
      tx,
    );
}

export type TaskRow = {
  id: string;
  order_id: string;
  store_id: string;
  customer_user_id: string | null;
  status: DeliveryTaskStatus;
  rider_id: string | null;
  attempt_no: number;
  offered_rider_id: string | null;
  pickup_at: Date | null;
  arrived_store_at: Date | null;
  arrived_customer_at: Date | null;
  dispatched_at: Date | null;
  delivered_at: Date | null;
  failure_reason: string | null;
  failure_evidence: Record<string, string> | null;
  pod_media_id: string | null;
  geofence_store_distance_m: number | null;
  geofence_customer_distance_m: number | null;
  eta_min_minutes: number | null;
  eta_max_minutes: number | null;
  eta_updated_at: Date | null;
  dispatch_attempts: number;
  next_dispatch_at: Date | null;
  no_rider_alerted_at: Date | null;
  distance_metres: number | null;
  cancel_reason: string | null;
  version: string;
  created_at: Date;
};

const TASK_COLUMNS =
  'id,order_id,store_id,customer_user_id,status,rider_id,attempt_no,offered_rider_id,pickup_at,arrived_store_at,arrived_customer_at,dispatched_at,delivered_at,failure_reason,failure_evidence,pod_media_id,geofence_store_distance_m,geofence_customer_distance_m,eta_min_minutes,eta_max_minutes,eta_updated_at,dispatch_attempts,next_dispatch_at,no_rider_alerted_at,distance_metres,cancel_reason,version::text AS "version",created_at';

export async function loadTask(
  tx: TransactionContext | Database,
  taskId: string,
  lock: boolean,
): Promise<TaskRow | null> {
  const rows =
    await sql<TaskRow>`SELECT ${sql.raw(TASK_COLUMNS)} FROM delivery_tasks WHERE id=${taskId}::uuid ${lock ? sql`FOR UPDATE` : sql``}`.execute(
      tx,
    );
  return rows.rows[0] ?? null;
}

export interface LockedOrder {
  id: string;
  payment_method: 'GATEWAY' | 'WALLET' | 'COD' | 'ZERO_DUE' | null;
  amount_due_paise: string;
  status: string;
  on_hold: boolean;
}

export async function lockOrder(
  tx: TransactionContext,
  orderId: string,
): Promise<LockedOrder | null> {
  // Lock hierarchy (plan 5.1): the order aggregate precedes task/rider locks.
  const rows = await sql<LockedOrder>`SELECT id,payment_method,
      COALESCE((SELECT expected_amount_paise FROM cod_collections WHERE order_id=orders.id),amount_due_paise)::text AS "amount_due_paise",status,on_hold
      FROM orders WHERE id=${orderId}::uuid FOR UPDATE`.execute(tx);
  return rows.rows[0] ?? null;
}

/** Task projection for surfaces; the handover code is filled by the caller. */
export function mapTaskRow(
  row: TaskRow,
  handoverCode: string | null,
  codAmountPaise: string | null,
) {
  return {
    id: row.id,
    orderId: row.order_id,
    storeId: row.store_id,
    status: row.status,
    riderId: row.rider_id,
    attemptNo: row.attempt_no,
    pickupAt: row.pickup_at?.toISOString() ?? null,
    arrivedStoreAt: row.arrived_store_at?.toISOString() ?? null,
    arrivedCustomerAt: row.arrived_customer_at?.toISOString() ?? null,
    deliveredAt: row.delivered_at?.toISOString() ?? null,
    etaMinMinutes: row.eta_min_minutes,
    etaMaxMinutes: row.eta_max_minutes,
    codAmountPaise,
    handoverCode,
    version: row.version,
  };
}

/** Pre-pickup custody statuses where the rider still shows the handover code. */
export function handoverVisible(status: DeliveryTaskStatus): boolean {
  return status === 'ASSIGNED' || status === 'AT_STORE';
}

/** Releases rider capacity and restores idle-since when the last task ends. */
export async function releaseRiderTask(
  tx: TransactionContext,
  riderId: string,
  at: Date,
): Promise<void> {
  await sql`UPDATE rider_status SET active_tasks=GREATEST(active_tasks-1,0),
    idle_since=CASE WHEN active_tasks<=1 THEN ${at.toISOString()}::timestamptz ELSE idle_since END,
    unreachable_since=NULL,version=version+1
    WHERE rider_id=${riderId}::uuid`.execute(tx);
}
