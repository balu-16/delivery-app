import { createHash } from 'node:crypto';
import { sql } from 'kysely';
import { uuidV7 } from '../../../common/ids/ids.js';
import type { TransactionContext } from '../../../platform/database/database.js';
import type {
  PickItemStatus,
  PickItemView,
  PickTaskStatus,
  PickTaskView,
} from '../contracts/tasks.js';

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
    await sql`INSERT INTO picking_operations(reference,kind,request_hash) VALUES(${reference},${kind},${hash}) ON CONFLICT DO NOTHING RETURNING reference`.execute(
      tx,
    );
  if (inserted.rows.length) return true;
  const old = await sql<{
    kind: string;
    request_hash: string;
  }>`SELECT kind,request_hash FROM picking_operations WHERE reference=${reference}`.execute(tx);
  if (old.rows[0]?.kind !== kind || old.rows[0]?.request_hash !== hash)
    throw new Error('IDEMPOTENCY_KEY_REUSED');
  return false;
}

export async function taskHistory(
  tx: TransactionContext,
  taskId: string,
  previousStatus: PickTaskStatus | null,
  status: PickTaskStatus,
  actorId: string | null,
  reason?: string,
): Promise<void> {
  await sql`INSERT INTO pick_task_history(id,task_id,version,previous_status,status,actor_id,reason) VALUES(${uuidV7()}::uuid,${taskId}::uuid,(SELECT COALESCE(max(version),0)+1 FROM pick_task_history WHERE task_id=${taskId}::uuid),${previousStatus},${status},${actorId}::uuid,${reason ?? null})`.execute(
    tx,
  );
}

/** Aggregate-scoped change event; consumers create durable delivery obligations. */
export async function taskEvent(
  tx: TransactionContext,
  taskId: string,
  orderId: string,
  eventType: string,
  payload: Record<string, unknown>,
  consumers: readonly string[] = [],
): Promise<void> {
  const version = await sql<{
    v: string;
  }>`SELECT COALESCE(max(version),0)+1 AS v FROM pick_task_history WHERE task_id=${taskId}::uuid`.execute(
    tx,
  );
  const eventId = uuidV7();
  await sql`INSERT INTO outbox_events(id,event_type,schema_version,aggregate_type,aggregate_id,aggregate_version,correlation_id,payload) VALUES(${eventId}::uuid,${eventType},1,'pick_task',${taskId}::uuid,${version.rows[0]!.v}::bigint,${orderId},${JSON.stringify({ taskId, orderId, ...payload })}::jsonb)`.execute(
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
  status: PickTaskStatus;
  assigned_to: string | null;
  started_at: Date | null;
  sla_due_at: Date;
  completed_at: Date | null;
  version: string;
};

export type ItemRow = {
  id: string;
  task_id: string;
  order_item_id: string;
  variant_id: string;
  substitute_variant_id: string | null;
  name_snapshot: string;
  expected_qty: string;
  picked_qty: string;
  batch_id: string | null;
  status: PickItemStatus;
  short_reason: string | null;
};

export function mapTask(row: TaskRow, items: ItemRow[]): PickTaskView {
  return {
    id: row.id,
    orderId: row.order_id,
    storeId: row.store_id,
    status: row.status,
    assignedTo: row.assigned_to,
    startedAt: row.started_at?.toISOString() ?? null,
    slaDueAt: row.sla_due_at.toISOString(),
    completedAt: row.completed_at?.toISOString() ?? null,
    version: row.version,
    // Items arrive in walk order (bin location, then id) from the loader.
    items: items.filter((item) => item.task_id === row.id).map(mapItem),
  };
}

export function mapItem(item: ItemRow): PickItemView {
  return {
    id: item.id,
    orderItemId: item.order_item_id,
    variantId: item.variant_id,
    substituteVariantId: item.substitute_variant_id,
    name: item.name_snapshot,
    expectedQty: item.expected_qty,
    pickedQty: item.picked_qty,
    batchId: item.batch_id,
    status: item.status,
    shortReason: (item.short_reason as PickItemView['shortReason']) ?? null,
    fefoSuggestions: [],
  };
}

export async function loadTask(
  tx: TransactionContext,
  taskId: string,
  lock: boolean,
): Promise<TaskRow | null> {
  const rows =
    await sql<TaskRow>`SELECT id,order_id,store_id,status,assigned_to,started_at,sla_due_at,completed_at,version::text FROM pick_tasks WHERE id=${taskId}::uuid ${lock ? sql`FOR UPDATE` : sql``}`.execute(
      tx,
    );
  return rows.rows[0] ?? null;
}

export async function loadItems(
  tx: TransactionContext,
  taskIds: readonly string[],
  lock = false,
): Promise<ItemRow[]> {
  if (!taskIds.length) return [];
  // Walk order: bin location, then item id, so every picker walks the same path.
  const rows =
    await sql<ItemRow>`SELECT i.id,i.task_id,i.order_item_id,i.variant_id,i.substitute_variant_id,i.name_snapshot,i.expected_qty::text AS "expected_qty",i.picked_qty::text AS "picked_qty",i.batch_id,i.status,i.short_reason FROM pick_items i JOIN pick_tasks t ON t.id=i.task_id LEFT JOIN store_inventory s ON s.store_id=t.store_id AND s.variant_id=i.variant_id WHERE i.task_id=ANY(${taskIds.slice()}::uuid[]) ORDER BY i.task_id,s.bin_location NULLS LAST,i.id ${lock ? sql`FOR UPDATE OF i` : sql``}`.execute(
      tx,
    );
  return rows.rows;
}

/** Opaque keyset cursor over (sla_due_at, id). */
export function encodeCursor(row: { sla_due_at: Date; id: string }): string {
  return Buffer.from(JSON.stringify([row.sla_due_at.toISOString(), row.id])).toString('base64url');
}

export function decodeCursor(cursor: string): { slaDueAt: string; id: string } | null {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (
      !Array.isArray(parsed) ||
      parsed.length !== 2 ||
      typeof parsed[0] !== 'string' ||
      typeof parsed[1] !== 'string'
    )
      return null;
    return { slaDueAt: parsed[0], id: parsed[1] };
  } catch {
    return null;
  }
}

export async function assertStoreRole(
  identity: {
    hasStoreRole(
      userId: string,
      storeId: string,
      roles: readonly string[],
      tx?: TransactionContext,
    ): Promise<boolean>;
  },
  userId: string,
  storeId: string,
  roles: readonly ('PICKER' | 'STORE_MANAGER')[],
  tx?: TransactionContext,
): Promise<void> {
  if (!(await identity.hasStoreRole(userId, storeId, roles, tx)))
    throw new Error('RESOURCE_NOT_FOUND');
}

export async function activeTaskCount(tx: TransactionContext, userId: string): Promise<number> {
  const rows = await sql<{
    count: string;
  }>`SELECT count(*)::text AS count FROM pick_tasks WHERE assigned_to=${userId}::uuid AND status IN ('ASSIGNED','IN_PROGRESS')`.execute(
    tx,
  );
  return Number(rows.rows[0]?.count ?? '0');
}
