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

/** Item-level change for customer notifications (shorts, substitutions). */
export async function itemEvent(
  tx: TransactionContext,
  taskId: string,
  orderId: string,
  orderItemId: string,
  variantId: string,
  status: 'SHORT' | 'SUBSTITUTED',
): Promise<void> {
  const eventId = uuidV7();
  const version = await sql<{ v: string }>`SELECT (COALESCE(max(aggregate_version),0)+1)::text AS v
    FROM outbox_events WHERE aggregate_type='pick_item' AND aggregate_id=${orderItemId}::uuid`.execute(
    tx,
  );
  await sql`INSERT INTO outbox_events(id,event_type,schema_version,aggregate_type,aggregate_id,aggregate_version,correlation_id,payload) VALUES(${eventId}::uuid,'picking.item_changed',1,'pick_item',${orderItemId}::uuid,${version.rows[0]!.v}::bigint,${orderId},${JSON.stringify({ taskId, orderId, orderItemId, variantId, status })}::jsonb)`.execute(
    tx,
  );
  await sql`INSERT INTO outbox_deliveries(event_id,consumer) VALUES(${eventId}::uuid,'notifications')`.execute(
    tx,
  );
}

export type TaskRow = {
  id: string;
  order_id: string;
  order_number: string | null;
  order_status: string;
  customer_name: string;
  store_id: string;
  status: PickTaskStatus;
  assigned_to: string | null;
  assigned_to_name: string | null;
  started_at: Date | null;
  sla_due_at: Date;
  completed_at: Date | null;
  version: string;
  packing_bags: number | null;
  packing_seal_code: string | null;
  packing_cold_chain: boolean | null;
  packing_packed_at: Date | null;
  packing_packed_by_name: string | null;
  handover_state: 'PENDING' | 'VERIFIED' | 'OVERRIDE' | null;
  handover_rider_id: string | null;
  handover_rider_name: string | null;
  handover_attempts: number | null;
  handover_locked_until: Date | null;
  handover_verified_at: Date | null;
  delivery_status: string | null;
};

export type SubstitutionCandidateRow = {
  variantId: string;
  name: string;
  sku: string;
  barcode: string | null;
  available: string;
};

export type ItemRow = {
  id: string;
  task_id: string;
  order_item_id: string;
  variant_id: string;
  substitute_variant_id: string | null;
  name_snapshot: string;
  sku: string;
  barcode: string | null;
  expected_qty: string;
  picked_qty: string;
  batch_id: string | null;
  batch_code: string | null;
  batch_expires_at: Date | null;
  status: PickItemStatus;
  short_reason: string | null;
  substitution_candidates: SubstitutionCandidateRow[];
};

export function mapTask(row: TaskRow, items: ItemRow[]): PickTaskView {
  return {
    id: row.id,
    orderId: row.order_id,
    orderNumber: row.order_number,
    orderStatus: row.order_status,
    customerName: row.customer_name,
    storeId: row.store_id,
    status: row.status,
    assignedTo: row.assigned_to,
    assignedToName: row.assigned_to_name,
    startedAt: row.started_at?.toISOString() ?? null,
    slaDueAt: row.sla_due_at.toISOString(),
    completedAt: row.completed_at?.toISOString() ?? null,
    version: row.version,
    packing:
      row.packing_bags === null || row.packing_packed_at === null
        ? null
        : {
            bags: row.packing_bags,
            sealCode: row.packing_seal_code ?? '',
            coldChain: row.packing_cold_chain ?? false,
            packedAt: row.packing_packed_at.toISOString(),
            packedBy: row.packing_packed_by_name,
          },
    handover:
      row.handover_state === null
        ? null
        : {
            state: row.handover_state,
            riderId: row.handover_rider_id,
            riderName: row.handover_rider_name,
            attempts: row.handover_attempts ?? 0,
            locked: Boolean(row.handover_locked_until && row.handover_locked_until > new Date()),
            verifiedAt: row.handover_verified_at?.toISOString() ?? null,
            deliveryStatus: row.delivery_status,
          },
    deliveryStatus: row.delivery_status,
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
    sku: item.sku,
    barcode: item.barcode,
    expectedQty: item.expected_qty,
    pickedQty: item.picked_qty,
    batchId: item.batch_id,
    batchCode: item.batch_code,
    batchExpiresAt: item.batch_expires_at?.toISOString() ?? null,
    status: item.status,
    shortReason: (item.short_reason as PickItemView['shortReason']) ?? null,
    fefoSuggestions: [],
    substitutionCandidates: item.substitution_candidates,
  };
}

export async function loadTask(
  tx: TransactionContext,
  taskId: string,
  lock: boolean,
): Promise<TaskRow | null> {
  const rows = await sql<TaskRow>`SELECT t.id,t.order_id,o.order_number,o.status AS order_status,
      COALESCE(cu.name,'') AS customer_name,t.store_id,t.status,t.assigned_to,au.name AS assigned_to_name,
      t.started_at,t.sla_due_at,t.completed_at,t.version::text,
      p.bags AS packing_bags,p.seal_code AS packing_seal_code,p.cold_chain AS packing_cold_chain,
      p.packed_at AS packing_packed_at,pu.name AS packing_packed_by_name,
      h.state AS handover_state,h.rider_id AS handover_rider_id,ru.name AS handover_rider_name,
      h.attempts AS handover_attempts,h.locked_until AS handover_locked_until,h.verified_at AS handover_verified_at,
      d.status AS delivery_status
    FROM pick_tasks t
    JOIN orders o ON o.id=t.order_id
    LEFT JOIN users cu ON cu.id=o.user_id
    LEFT JOIN users au ON au.id=t.assigned_to
    LEFT JOIN packing_records p ON p.order_id=t.order_id
    LEFT JOIN users pu ON pu.id=p.packed_by
    LEFT JOIN handover_records h ON h.order_id=t.order_id
    LEFT JOIN users ru ON ru.id=h.rider_id
    LEFT JOIN LATERAL (
      SELECT dt.status FROM delivery_tasks dt WHERE dt.order_id=t.order_id ORDER BY dt.created_at DESC LIMIT 1
    ) d ON true
    WHERE t.id=${taskId}::uuid ${lock ? sql`FOR UPDATE OF t` : sql``}`.execute(tx);
  return rows.rows[0] ?? null;
}

export async function loadItems(
  tx: TransactionContext,
  taskIds: readonly string[],
  lock = false,
): Promise<ItemRow[]> {
  if (!taskIds.length) return [];
  // Walk order: item id (store_inventory has no bin_location column yet; add
  // it with the catalog schema before enabling aisle-order picking).
  const rows = await sql<
    Omit<ItemRow, 'substitution_candidates'>
  >`SELECT i.id,i.task_id,i.order_item_id,i.variant_id,i.substitute_variant_id,i.name_snapshot,
        v.sku,v.barcode,i.expected_qty::text AS "expected_qty",i.picked_qty::text AS "picked_qty",i.batch_id,
        b.batch_code,b.expires_at AS batch_expires_at,i.status,i.short_reason
      FROM pick_items i
      JOIN pick_tasks t ON t.id=i.task_id
      JOIN catalog_variants v ON v.id=COALESCE(i.substitute_variant_id,i.variant_id)
      LEFT JOIN inventory_batches b ON b.id=i.batch_id
      LEFT JOIN store_inventory s ON s.store_id=t.store_id AND s.variant_id=COALESCE(i.substitute_variant_id,i.variant_id)
      WHERE i.task_id=ANY(${taskIds.slice()}::uuid[]) ORDER BY i.task_id,s.bin_location ASC NULLS LAST,i.id ${lock ? sql`FOR UPDATE OF i` : sql``}`.execute(
    tx,
  );
  const items: ItemRow[] = rows.rows.map((row) => ({ ...row, substitution_candidates: [] }));
  const candidates = await sql<
    SubstitutionCandidateRow & { item_id: string }
  >`SELECT i.id AS item_id,
      c.candidate_variant_id AS "variantId",v.name,v.sku,v.barcode,
      COALESCE(si.on_hand-si.reserved,0)::text AS available
    FROM pick_items i
    JOIN pick_tasks t ON t.id=i.task_id
    JOIN substitute_candidates c ON c.variant_id=i.variant_id
    JOIN catalog_variants v ON v.id=c.candidate_variant_id AND v.deleted_at IS NULL
    LEFT JOIN store_inventory si ON si.store_id=t.store_id AND si.variant_id=c.candidate_variant_id
    WHERE i.task_id=ANY(${taskIds.slice()}::uuid[]) AND i.status='PENDING'
    ORDER BY v.name,c.candidate_variant_id`.execute(tx);
  const byItem = new Map<string, SubstitutionCandidateRow[]>();
  for (const candidate of candidates.rows) {
    const list = byItem.get(candidate.item_id) ?? [];
    list.push({
      variantId: candidate.variantId,
      name: candidate.name,
      sku: candidate.sku,
      barcode: candidate.barcode,
      available: candidate.available,
    });
    byItem.set(candidate.item_id, list);
  }
  for (const item of items) item.substitution_candidates = byItem.get(item.id) ?? [];
  return items;
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
  roles: readonly 'STORE_MANAGER'[],
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
