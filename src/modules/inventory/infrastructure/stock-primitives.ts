import { createHash } from 'node:crypto';
import { sql } from 'kysely';
import { uuidV7 } from '../../../common/ids/ids.js';
import type { TransactionContext } from '../../../platform/database/database.js';
import type { ReservationLine } from '../contracts/inventory.js';

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
export async function operation(
  tx: TransactionContext,
  reference: string,
  kind: string,
  input: unknown,
): Promise<boolean> {
  if (!reference || reference.length > 300) throw new Error('INVALID_INPUT');
  const hash = fingerprint(input);
  const inserted =
    await sql`INSERT INTO inventory_operations(reference,kind,request_hash) VALUES(${reference},${kind},${hash}) ON CONFLICT DO NOTHING RETURNING reference`.execute(
      tx,
    );
  if (inserted.rows.length) return true;
  const old = await sql<{
    kind: string;
    request_hash: string;
  }>`SELECT kind,request_hash FROM inventory_operations WHERE reference=${reference}`.execute(tx);
  if (old.rows[0]?.kind !== kind || old.rows[0]?.request_hash !== hash)
    throw new Error('IDEMPOTENCY_KEY_REUSED');
  return false;
}
export function sortedLines<T extends ReservationLine>(lines: T[]): T[] {
  return [...lines].sort(
    (a, b) => a.storeId.localeCompare(b.storeId) || a.variantId.localeCompare(b.variantId),
  );
}
export async function lockStock(
  tx: TransactionContext,
  lines: ReservationLine[],
  allowMissing = false,
): Promise<Set<string>> {
  const missing = new Set<string>();
  for (const line of sortedLines(lines)) {
    const found =
      await sql`SELECT store_id FROM store_inventory WHERE store_id=${line.storeId}::uuid AND variant_id=${line.variantId}::uuid FOR UPDATE`.execute(
        tx,
      );
    if (!found.rows.length) {
      if (!allowMissing) throw new Error('INVENTORY_INSUFFICIENT');
      missing.add(`${line.storeId}:${line.variantId}`);
    }
  }
  return missing;
}
export async function movement(
  tx: TransactionContext,
  input: {
    reference: string;
    storeId: string;
    variantId: string;
    batchId: string;
    kind: string;
    onHand: bigint;
    reserved: bigint;
    actor?: string;
  },
): Promise<void> {
  if (input.onHand === 0n && input.reserved === 0n) return;
  await sql`UPDATE inventory_batches SET on_hand=on_hand+${input.onHand.toString()}::bigint,reserved=reserved+${input.reserved.toString()}::bigint WHERE id=${input.batchId}::uuid`.execute(
    tx,
  );
  await sql`UPDATE store_inventory SET on_hand=on_hand+${input.onHand.toString()}::bigint,reserved=reserved+${input.reserved.toString()}::bigint,version=version+1 WHERE store_id=${input.storeId}::uuid AND variant_id=${input.variantId}::uuid`.execute(
    tx,
  );
  await sql`INSERT INTO inventory_ledger(id,reference,store_id,variant_id,batch_id,kind,on_hand_delta,reserved_delta,actor_id) VALUES(${uuidV7()}::uuid,${input.reference},${input.storeId}::uuid,${input.variantId}::uuid,${input.batchId}::uuid,${input.kind},${input.onHand.toString()}::bigint,${input.reserved.toString()}::bigint,${input.actor ?? null}::uuid)`.execute(
    tx,
  );
}

export async function reservationEvent(
  tx: TransactionContext,
  orderId: string,
  previous: string | null,
  state: string,
  action: string,
): Promise<void> {
  const row = await sql<{
    version: string;
  }>`INSERT INTO inventory_reservation_history(id,order_id,version,previous_state,state,action) VALUES(${uuidV7()}::uuid,${orderId}::uuid,(SELECT COALESCE(max(version),0)+1 FROM inventory_reservation_history WHERE order_id=${orderId}::uuid),${previous},${state},${action}) RETURNING version::text`.execute(
    tx,
  );
  const version = row.rows[0]!.version;
  await sql`INSERT INTO outbox_events(id,event_type,schema_version,aggregate_type,aggregate_id,aggregate_version,correlation_id,payload) VALUES(${uuidV7()}::uuid,'inventory.reservation_changed',1,'inventory_reservation',${orderId}::uuid,${version}::bigint,${orderId},${JSON.stringify({ orderId, previous, state, action })}::jsonb)`.execute(
    tx,
  );
}
