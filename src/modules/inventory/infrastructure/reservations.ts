import { stockAlerts } from './alerts.js';
import { sql } from 'kysely';
import {
  databaseTimeAfterLock,
  transactionWithRetry,
  type Database,
  type TransactionContext,
} from '../../../platform/database/database.js';
import type {
  InventoryReservations,
  PickLine,
  ReservationLine,
  ReserveInput,
} from '../contracts/inventory.js';
import { eligible, quantity } from '../domain/quantity.js';
import {
  lockStock,
  movement,
  operation,
  reservationEvent,
  sortedLines,
} from './stock-primitives.js';
import { resolveReservation } from './resolution.js';

export class PostgresReservations implements InventoryReservations {
  constructor(private readonly db: Database) {}
  private run<T>(
    tx: TransactionContext | undefined,
    fn: (tx: TransactionContext) => Promise<T>,
  ): Promise<T> {
    return tx ? fn(tx) : transactionWithRetry(this.db, fn);
  }
  async reserve(input: ReserveInput, outer?: TransactionContext): Promise<void> {
    if (
      !input.lines.length ||
      input.lines.length > 100 ||
      !Number.isSafeInteger(input.ttlSeconds) ||
      input.ttlSeconds < 1 ||
      input.ttlSeconds > 86400
    )
      throw new Error('INVALID_INPUT');
    const lines = sortedLines(input.lines);
    const seen = new Set<string>();
    for (const line of lines) {
      quantity(line.quantity);
      const key = `${line.storeId}:${line.variantId}`;
      if (seen.has(key)) throw new Error('INVALID_INPUT');
      seen.add(key);
    }
    const target = new Date(input.targetDeliveryAt);
    if (!Number.isFinite(target.getTime())) throw new Error('INVALID_TARGET_TIME');
    await this.run(outer, async (tx) => {
      await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`inventory-order:${input.orderId}`},0))`.execute(
        tx,
      );
      const reference = `reserve:${input.orderId}`;
      if (!(await operation(tx, reference, 'RESERVE', { ...input, lines }))) return;
      const missing = await lockStock(tx, lines, true);
      const candidates: Array<{
        line: ReservationLine;
        batches: Array<{
          id: string;
          available: string;
          expires_at: Date | null;
          min_seconds: number;
        }>;
      }> = [];
      for (const line of lines) {
        if (missing.has(`${line.storeId}:${line.variantId}`)) {
          candidates.push({ line, batches: [] });
          continue;
        }
        const rows = await sql<{
          id: string;
          available: string;
          expires_at: Date | null;
          min_seconds: number;
        }>`SELECT b.id,(b.on_hand-b.reserved)::text AS available,b.expires_at,COALESCE(s.min_seconds,0) AS min_seconds FROM inventory_batches b JOIN catalog_variants v ON v.id=b.variant_id JOIN catalog_products p ON p.id=v.product_id LEFT JOIN inventory_category_shelf_life s ON s.category_id=p.category_id WHERE b.store_id=${line.storeId}::uuid AND b.variant_id=${line.variantId}::uuid AND b.state='ACTIVE' AND b.on_hand>b.reserved ORDER BY b.expires_at ASC NULLS LAST,b.id FOR UPDATE OF b`.execute(
          tx,
        );
        candidates.push({ line, batches: rows.rows });
      }
      const now = await databaseTimeAfterLock(tx);
      const shortfalls: Array<{
        storeId: string;
        variantId: string;
        requested: string;
        available: string;
      }> = [];
      for (const item of candidates) {
        item.batches = item.batches.filter((b) =>
          eligible(
            b.expires_at,
            new Date(Math.max(now.getTime(), target.getTime())),
            b.min_seconds,
          ),
        );
        const available = item.batches.reduce((sum, b) => sum + BigInt(b.available), 0n);
        if (available < BigInt(item.line.quantity))
          shortfalls.push({
            ...item.line,
            requested: item.line.quantity,
            available: available.toString(),
          });
      }
      if (shortfalls.length) throw new InventoryInsufficient(shortfalls);
      for (const { line, batches } of candidates) {
        await sql`INSERT INTO inventory_reservations(order_id,store_id,variant_id,quantity,state,expires_at,target_delivery_at) VALUES(${input.orderId}::uuid,${line.storeId}::uuid,${line.variantId}::uuid,${line.quantity}::bigint,'HELD',${new Date(now.getTime() + input.ttlSeconds * 1000)},${target})`.execute(
          tx,
        );
        let remaining = BigInt(line.quantity);
        for (const batch of batches) {
          const take = remaining < BigInt(batch.available) ? remaining : BigInt(batch.available);
          if (!take) continue;
          await sql`INSERT INTO inventory_allocations(order_id,store_id,variant_id,batch_id,quantity) VALUES(${input.orderId}::uuid,${line.storeId}::uuid,${line.variantId}::uuid,${batch.id}::uuid,${take.toString()}::bigint)`.execute(
            tx,
          );
          await movement(tx, {
            reference,
            storeId: line.storeId,
            variantId: line.variantId,
            batchId: batch.id,
            kind: 'RESERVE',
            onHand: 0n,
            reserved: take,
          });
          remaining -= take;
          if (!remaining) break;
        }
      }
      for (const line of lines) await stockAlerts(tx, line.storeId, line.variantId);
      await reservationEvent(tx, input.orderId, null, 'HELD', 'RESERVE');
    });
  }
  commit(orderId: string, outer?: TransactionContext): Promise<void> {
    return this.run(outer, (tx) => resolveReservation(tx, orderId, 'COMMIT'));
  }
  release(orderId: string, outer?: TransactionContext): Promise<void> {
    return this.run(outer, (tx) => resolveReservation(tx, orderId, 'RELEASE'));
  }
  pick(orderId: string, lines: PickLine[], outer?: TransactionContext): Promise<void> {
    return this.run(outer, (tx) => resolveReservation(tx, orderId, 'PICK', lines));
  }
}
export class InventoryInsufficient extends Error {
  readonly code = 'INVENTORY_INSUFFICIENT';
  constructor(
    readonly shortfalls: Array<{
      storeId: string;
      variantId: string;
      requested: string;
      available: string;
    }>,
  ) {
    super('INVENTORY_INSUFFICIENT');
  }
}
