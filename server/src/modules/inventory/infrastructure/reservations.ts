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
    if (
      input.cycleReference !== undefined &&
      (!input.cycleReference || input.cycleReference.length > 150)
    )
      throw new Error('INVALID_INPUT');
    await this.run(outer, async (tx) => {
      await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`inventory-order:${input.orderId}`},0))`.execute(
        tx,
      );
      const reference = `reserve:${input.orderId}${input.cycleReference ? `:${input.cycleReference}` : ''}`;
      if (!(await operation(tx, reference, 'RESERVE', { ...input, lines }))) return;
      const missing = await lockStock(tx, lines, true);
      // New commerce reservations only: decide listing-vs-withdrawal under the
      // inventory row lock taken by lockStock above.
      if (input.requireListed) {
        let pairs: ReturnType<typeof sql> | undefined;
        for (const line of lines) {
          const pair = sql`(${line.storeId}::uuid,${line.variantId}::uuid)`;
          pairs = pairs ? sql`${pairs},${pair}` : pair;
        }
        const listing = await sql<{
          store_id: string;
          variant_id: string;
          listed: boolean;
        }>`SELECT store_id::text AS store_id,variant_id::text AS variant_id,listed FROM store_inventory WHERE (store_id,variant_id) IN (VALUES ${pairs!}) FOR SHARE`.execute(
          tx,
        );
        const unlisted = new Set(
          listing.rows.filter((r) => !r.listed).map((r) => `${r.store_id}:${r.variant_id}`),
        );
        const withdrawn = lines.filter((line) => unlisted.has(`${line.storeId}:${line.variantId}`));
        if (withdrawn.length)
          throw new InventoryInsufficient(
            withdrawn.map((line) => ({
              ...line,
              requested: line.quantity,
              available: '0',
            })),
          );
      }
      const previous = await sql<{
        state: string;
        generation: number;
      }>`SELECT state,generation FROM inventory_reservations
        WHERE order_id=${input.orderId}::uuid ORDER BY store_id,variant_id FOR UPDATE`.execute(tx);
      let generation = 1;
      if (previous.rows.length) {
        if (!input.cycleReference || previous.rows.some((row) => row.state !== 'RESOLVED'))
          throw new Error('RESERVATION_STATE_INVALID');
        generation = Math.max(...previous.rows.map((row) => row.generation)) + 1;
        await sql`INSERT INTO inventory_reservation_cycles(order_id,generation,reservations,allocations)
          SELECT ${input.orderId}::uuid,${generation - 1},
          (SELECT jsonb_agg(to_jsonb(r)) FROM inventory_reservations r WHERE order_id=${input.orderId}::uuid),
          COALESCE((SELECT jsonb_agg(to_jsonb(a)) FROM inventory_allocations a WHERE order_id=${input.orderId}::uuid),'[]'::jsonb)`.execute(
          tx,
        );
        await sql`DELETE FROM inventory_allocations WHERE order_id=${input.orderId}::uuid`.execute(
          tx,
        );
        await sql`DELETE FROM inventory_reservations WHERE order_id=${input.orderId}::uuid`.execute(
          tx,
        );
      }
      const candidates: Array<{
        line: ReservationLine;
        batches: Array<{
          id: string;
          available: string;
          expires_at: Date | null;
          min_seconds: number;
        }>;
      }> = lines.map((line) => ({ line, batches: [] }));
      const present = lines.filter((line) => !missing.has(`${line.storeId}:${line.variantId}`));
      if (present.length) {
        let pairs: ReturnType<typeof sql> | undefined;
        for (const line of present) {
          const pair = sql`(${line.storeId}::uuid,${line.variantId}::uuid)`;
          pairs = pairs ? sql`${pairs},${pair}` : pair;
        }
        const rows = await sql<{
          store_id: string;
          variant_id: string;
          id: string;
          available: string;
          expires_at: Date | null;
          min_seconds: number;
        }>`SELECT b.store_id::text AS store_id,b.variant_id::text AS variant_id,b.id,(b.on_hand-b.reserved)::text AS available,b.expires_at,COALESCE(s.min_seconds,0) AS min_seconds FROM inventory_batches b JOIN catalog_variants v ON v.id=b.variant_id JOIN catalog_products p ON p.id=v.product_id LEFT JOIN inventory_category_shelf_life s ON s.category_id=p.category_id WHERE (b.store_id,b.variant_id) IN (VALUES ${pairs!}) AND b.state='ACTIVE' AND b.on_hand>b.reserved ORDER BY b.store_id,b.variant_id,b.expires_at ASC NULLS LAST,b.id FOR UPDATE OF b`.execute(
          tx,
        );
        // Preserve per-line FEFO order; rows arrive grouped and ordered.
        const byLine = new Map<string, typeof rows.rows>();
        for (const row of rows.rows) {
          const key = `${row.store_id}:${row.variant_id}`;
          const list = byLine.get(key) ?? [];
          list.push(row);
          byLine.set(key, list);
        }
        for (const candidate of candidates) {
          if (missing.has(`${candidate.line.storeId}:${candidate.line.variantId}`)) continue;
          candidate.batches =
            byLine.get(`${candidate.line.storeId}:${candidate.line.variantId}`) ?? [];
        }
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
      // Batch the reservation + allocation inserts as single multi-row
      // statements in the same sorted line / FEFO batch order as the
      // per-row loop. All effects stay in this transaction (all-or-nothing).
      // Movements deliberately stay per-batch: each call bumps
      // store_inventory.version once, so batching them would change version
      // semantics; the lock order is already fixed by lockStock above.
      if (candidates.length) {
        const expiresAt = new Date(now.getTime() + input.ttlSeconds * 1000);
        let reservationValues: ReturnType<typeof sql> | undefined;
        for (const { line } of candidates) {
          const row = sql`(${input.orderId}::uuid,${line.storeId}::uuid,${line.variantId}::uuid,${line.quantity}::bigint,'HELD',${expiresAt},${target},${generation})`;
          reservationValues = reservationValues ? sql`${reservationValues},${row}` : row;
        }
        await sql`INSERT INTO inventory_reservations(order_id,store_id,variant_id,quantity,state,expires_at,target_delivery_at,generation) VALUES ${reservationValues!}`.execute(
          tx,
        );
        const allocations: Array<{
          line: ReservationLine;
          batchId: string;
          take: bigint;
        }> = [];
        for (const { line, batches } of candidates) {
          let remaining = BigInt(line.quantity);
          for (const batch of batches) {
            const take = remaining < BigInt(batch.available) ? remaining : BigInt(batch.available);
            if (!take) continue;
            allocations.push({ line, batchId: batch.id, take });
            remaining -= take;
            if (!remaining) break;
          }
        }
        if (allocations.length) {
          let allocationValues: ReturnType<typeof sql> | undefined;
          for (const allocation of allocations) {
            const row = sql`(${input.orderId}::uuid,${allocation.line.storeId}::uuid,${allocation.line.variantId}::uuid,${allocation.batchId}::uuid,${allocation.take.toString()}::bigint)`;
            allocationValues = allocationValues ? sql`${allocationValues},${row}` : row;
          }
          await sql`INSERT INTO inventory_allocations(order_id,store_id,variant_id,batch_id,quantity) VALUES ${allocationValues!}`.execute(
            tx,
          );
        }
        for (const allocation of allocations) {
          await movement(tx, {
            reference,
            storeId: allocation.line.storeId,
            variantId: allocation.line.variantId,
            batchId: allocation.batchId,
            kind: 'RESERVE',
            onHand: 0n,
            reserved: allocation.take,
          });
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
