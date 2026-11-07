import { sql } from 'kysely';
import {
  databaseTimeAfterLock,
  transactionWithRetry,
  type Database,
  type TransactionContext,
} from '../../../platform/database/database.js';
import { quantity, eligible } from '../domain/quantity.js';
import type {
  InventorySubstitutionSwaps,
  ReservationSwapInput,
} from '../contracts/substitution.js';
import { lockStock, movement, operation, reservationEvent } from './stock-primitives.js';
import { stockAlerts } from './alerts.js';

type ReservationRow = {
  quantity: string;
  state: 'HELD' | 'COMMITTED';
  expires_at: Date | null;
};

/**
 * Swap one reservation line for another under the order lock. The released
 * part gives up its batch allocations; the acquired part allocates FEFO
 * batches with the same eligibility rules and inherits the aggregate state,
 * so later pick resolution still sees a consistent COMMITTED (or HELD) set.
 */
export class PostgresSubstitutionSwaps implements InventorySubstitutionSwaps {
  constructor(private readonly db: Database) {}
  private run<T>(
    tx: TransactionContext | undefined,
    fn: (tx: TransactionContext) => Promise<T>,
  ): Promise<T> {
    return tx ? fn(tx) : transactionWithRetry(this.db, fn);
  }
  async swap(input: ReservationSwapInput, outer?: TransactionContext): Promise<void> {
    quantity(input.quantity);
    if (input.releaseVariantId === input.acquireVariantId) throw new Error('INVALID_INPUT');
    const move = BigInt(input.quantity);
    if (move <= 0n) throw new Error('INVALID_QUANTITY');
    const target = new Date(input.targetDeliveryAt);
    if (!Number.isFinite(target.getTime())) throw new Error('INVALID_TARGET_TIME');
    await this.run(outer, async (tx) => {
      await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`inventory-order:${input.orderId}`},0))`.execute(
        tx,
      );
      if (
        !(await operation(tx, `swap:${input.reference}`, 'SWAP', {
          orderId: input.orderId,
          releaseVariantId: input.releaseVariantId,
          acquireVariantId: input.acquireVariantId,
          quantity: input.quantity,
        }))
      )
        return;
      await lockStock(tx, [
        { storeId: input.storeId, variantId: input.releaseVariantId, quantity: input.quantity },
        { storeId: input.storeId, variantId: input.acquireVariantId, quantity: input.quantity },
      ]);
      const released =
        await sql<ReservationRow>`SELECT quantity::text,state,expires_at FROM inventory_reservations WHERE order_id=${input.orderId}::uuid AND store_id=${input.storeId}::uuid AND variant_id=${input.releaseVariantId}::uuid FOR UPDATE`.execute(
          tx,
        );
      const row = released.rows[0];
      if (!row) throw new Error('RESOURCE_NOT_FOUND');
      if (BigInt(row.quantity) < move) throw new Error('INVALID_QUANTITY');
      const duplicate =
        await sql`SELECT 1 AS one FROM inventory_reservations WHERE order_id=${input.orderId}::uuid AND store_id=${input.storeId}::uuid AND variant_id=${input.acquireVariantId}::uuid`.execute(
          tx,
        );
      if (duplicate.rows.length) throw new Error('RESERVATION_STATE_INVALID');
      const now = await databaseTimeAfterLock(tx);
      // Release the original quantity from its allocations (largest batch last keeps FEFO stock).
      const allocations = await sql<{
        batch_id: string;
        quantity: string;
      }>`SELECT batch_id,quantity::text FROM inventory_allocations WHERE order_id=${input.orderId}::uuid AND store_id=${input.storeId}::uuid AND variant_id=${input.releaseVariantId}::uuid ORDER BY batch_id DESC FOR UPDATE`.execute(
        tx,
      );
      let remaining = move;
      for (const allocation of allocations.rows) {
        if (remaining <= 0n) break;
        const held = BigInt(allocation.quantity);
        const take = remaining < held ? remaining : held;
        remaining -= take;
        const rest = held - take;
        await movement(tx, {
          reference: `swap:${input.reference}`,
          storeId: input.storeId,
          variantId: input.releaseVariantId,
          batchId: allocation.batch_id,
          kind: 'RELEASE',
          onHand: 0n,
          reserved: -take,
        });
        if (rest > 0n)
          await sql`UPDATE inventory_allocations SET quantity=${rest.toString()}::bigint WHERE order_id=${input.orderId}::uuid AND store_id=${input.storeId}::uuid AND variant_id=${input.releaseVariantId}::uuid AND batch_id=${allocation.batch_id}::uuid`.execute(
            tx,
          );
        else
          await sql`DELETE FROM inventory_allocations WHERE order_id=${input.orderId}::uuid AND store_id=${input.storeId}::uuid AND variant_id=${input.releaseVariantId}::uuid AND batch_id=${allocation.batch_id}::uuid`.execute(
            tx,
          );
      }
      const left = BigInt(row.quantity) - move;
      if (left > 0n)
        await sql`UPDATE inventory_reservations SET quantity=${left.toString()}::bigint WHERE order_id=${input.orderId}::uuid AND store_id=${input.storeId}::uuid AND variant_id=${input.releaseVariantId}::uuid`.execute(
          tx,
        );
      else
        await sql`DELETE FROM inventory_reservations WHERE order_id=${input.orderId}::uuid AND store_id=${input.storeId}::uuid AND variant_id=${input.releaseVariantId}::uuid`.execute(
          tx,
        );
      // Reserve the replacement FEFO and inherit the aggregate state.
      const batches = await sql<{
        id: string;
        available: string;
        expires_at: Date | null;
        min_seconds: number;
      }>`SELECT b.id,(b.on_hand-b.reserved)::text AS available,b.expires_at,COALESCE(s.min_seconds,0) AS min_seconds FROM inventory_batches b JOIN catalog_variants v ON v.id=b.variant_id JOIN catalog_products p ON p.id=v.product_id LEFT JOIN inventory_category_shelf_life s ON s.category_id=p.category_id WHERE b.store_id=${input.storeId}::uuid AND b.variant_id=${input.acquireVariantId}::uuid AND b.state='ACTIVE' AND b.on_hand>b.reserved ORDER BY b.expires_at ASC NULLS LAST,b.id FOR UPDATE OF b`.execute(
        tx,
      );
      const usable = batches.rows.filter((b) =>
        eligible(b.expires_at, new Date(Math.max(now.getTime(), target.getTime())), b.min_seconds),
      );
      const available = usable.reduce((sum, b) => sum + BigInt(b.available), 0n);
      if (available < move) throw new Error('INVENTORY_INSUFFICIENT');
      await sql`INSERT INTO inventory_reservations(order_id,store_id,variant_id,quantity,state,expires_at,target_delivery_at) VALUES(${input.orderId}::uuid,${input.storeId}::uuid,${input.acquireVariantId}::uuid,${input.quantity}::bigint,${row.state},${row.expires_at},${target})`.execute(
        tx,
      );
      let pending = move;
      for (const batch of usable) {
        const take = pending < BigInt(batch.available) ? pending : BigInt(batch.available);
        if (!take) continue;
        await sql`INSERT INTO inventory_allocations(order_id,store_id,variant_id,batch_id,quantity) VALUES(${input.orderId}::uuid,${input.storeId}::uuid,${input.acquireVariantId}::uuid,${batch.id}::uuid,${take.toString()}::bigint)`.execute(
          tx,
        );
        await movement(tx, {
          reference: `swap:${input.reference}`,
          storeId: input.storeId,
          variantId: input.acquireVariantId,
          batchId: batch.id,
          kind: 'RESERVE',
          onHand: 0n,
          reserved: take,
        });
        pending -= take;
        if (!pending) break;
      }
      await stockAlerts(tx, input.storeId, input.releaseVariantId);
      await stockAlerts(tx, input.storeId, input.acquireVariantId);
      await reservationEvent(tx, input.orderId, row.state, row.state, 'SWAP');
    });
  }
}
