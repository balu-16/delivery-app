import { stockAlerts } from './alerts.js';
import { sql } from 'kysely';
import {
  databaseTimeAfterLock,
  type TransactionContext,
} from '../../../platform/database/database.js';
import type { PickLine } from '../contracts/inventory.js';
import { quantity } from '../domain/quantity.js';
import { canTransition, type ReservationState } from '../domain/reservation-policy.js';
import {
  lockStock,
  movement,
  operation,
  reservationEvent,
  sortedLines,
} from './stock-primitives.js';

type Reservation = {
  store_id: string;
  variant_id: string;
  quantity: string;
  state: ReservationState;
  expires_at: Date | null;
};
type Allocation = { store_id: string; variant_id: string; batch_id: string; quantity: string };
export async function resolveReservation(
  tx: TransactionContext,
  orderId: string,
  action: 'COMMIT' | 'RELEASE' | 'PICK' | 'EXPIRE',
  picks: PickLine[] = [],
): Promise<void> {
  await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`inventory-order:${orderId}`},0))`.execute(
    tx,
  );
  const basic =
    await sql<Reservation>`SELECT store_id,variant_id,quantity::text,state,expires_at FROM inventory_reservations WHERE order_id=${orderId}::uuid ORDER BY store_id,variant_id`.execute(
      tx,
    );
  if (!basic.rows.length) throw new Error('RESOURCE_NOT_FOUND');
  await lockStock(
    tx,
    basic.rows.map((r) => ({ storeId: r.store_id, variantId: r.variant_id, quantity: r.quantity })),
  );
  const rows =
    await sql<Reservation>`SELECT store_id,variant_id,quantity::text,state,expires_at FROM inventory_reservations WHERE order_id=${orderId}::uuid ORDER BY store_id,variant_id FOR UPDATE`.execute(
      tx,
    );
  const allocations =
    await sql<Allocation>`SELECT a.store_id,a.variant_id,a.batch_id,a.quantity::text FROM inventory_allocations a JOIN inventory_batches b ON b.id=a.batch_id WHERE a.order_id=${orderId}::uuid ORDER BY a.store_id,a.variant_id,b.expires_at ASC NULLS LAST,b.id FOR UPDATE OF b,a`.execute(
      tx,
    );
  const now = await databaseTimeAfterLock(tx);
  if (
    action === 'EXPIRE' &&
    rows.rows.some((r) => !canTransition(r.state, action, r.expires_at, now))
  )
    return;
  const ordered = sortedLines(picks);
  const key = `${action.toLowerCase()}:${orderId}`;
  if (!(await operation(tx, key, action, { orderId, lines: ordered }))) return;
  if (action === 'COMMIT' || action === 'PICK') {
    const invalid =
      await sql`SELECT a.batch_id FROM inventory_allocations a JOIN inventory_reservations r ON r.order_id=a.order_id AND r.store_id=a.store_id AND r.variant_id=a.variant_id JOIN inventory_batches b ON b.id=a.batch_id JOIN catalog_variants v ON v.id=a.variant_id JOIN catalog_products p ON p.id=v.product_id LEFT JOIN inventory_category_shelf_life s ON s.category_id=p.category_id WHERE a.order_id=${orderId}::uuid AND (b.state<>'ACTIVE' OR (b.expires_at IS NOT NULL AND b.expires_at<=GREATEST(${now}::timestamptz,r.target_delivery_at)+COALESCE(s.min_seconds,0)*interval '1 second')) LIMIT 1`.execute(
        tx,
      );
    if (invalid.rows.length) throw new Error('INVENTORY_INSUFFICIENT');
  }
  if (action === 'COMMIT') {
    if (rows.rows.some((r) => r.state !== 'HELD' || !r.expires_at || r.expires_at <= now))
      throw new Error('RESERVATION_STATE_INVALID');
    await sql`UPDATE inventory_reservations SET state='COMMITTED',expires_at=NULL WHERE order_id=${orderId}::uuid`.execute(
      tx,
    );
    await reservationEvent(tx, orderId, 'HELD', 'COMMITTED', 'COMMIT');
    return;
  }
  if (action === 'PICK') {
    if (rows.rows.some((r) => r.state !== 'COMMITTED') || ordered.length !== rows.rows.length)
      throw new Error('RESERVATION_STATE_INVALID');
    const keys = new Set<string>();
    for (const pick of ordered) {
      quantity(pick.quantity, true);
      const key2 = `${pick.storeId}:${pick.variantId}`;
      if (keys.has(key2)) throw new Error('INVALID_INPUT');
      keys.add(key2);
      const row = rows.rows.find(
        (r) => r.store_id === pick.storeId && r.variant_id === pick.variantId,
      );
      if (!row || BigInt(pick.quantity) > BigInt(row.quantity)) throw new Error('INVALID_QUANTITY');
    }
  } else if (rows.rows.some((r) => r.state === 'RESOLVED'))
    throw new Error('RESERVATION_STATE_INVALID');
  for (const row of rows.rows) {
    let remaining =
      action === 'PICK'
        ? BigInt(
            ordered.find((p) => p.storeId === row.store_id && p.variantId === row.variant_id)!
              .quantity,
          )
        : 0n;
    for (const allocation of allocations.rows.filter(
      (a) => a.store_id === row.store_id && a.variant_id === row.variant_id,
    )) {
      const held = BigInt(allocation.quantity);
      const consumed = remaining < held ? remaining : held;
      remaining -= consumed;
      await movement(tx, {
        reference: key,
        storeId: row.store_id,
        variantId: row.variant_id,
        batchId: allocation.batch_id,
        kind: action === 'PICK' ? 'RESERVE_COMMIT_PICK' : action,
        onHand: -consumed,
        reserved: -held,
      });
    }
  }
  await sql`UPDATE inventory_shortfall_obligations SET resolved_at=clock_timestamp() WHERE order_id=${orderId}::uuid AND resolved_at IS NULL`.execute(
    tx,
  );
  await sql`UPDATE inventory_reservations SET state='RESOLVED',expires_at=NULL,resolved_kind=${action} WHERE order_id=${orderId}::uuid`.execute(
    tx,
  );
  for (const row of rows.rows) await stockAlerts(tx, row.store_id, row.variant_id);
  await reservationEvent(tx, orderId, rows.rows[0]!.state, 'RESOLVED', action);
}
