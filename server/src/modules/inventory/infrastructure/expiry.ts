import { stockAlerts } from './alerts.js';
import { sql } from 'kysely';
import { INVENTORY_CONFIG_DEFAULTS } from '../../app-config/contracts/config.js';
import { uuidV7 } from '../../../common/ids/ids.js';
import {
  databaseTimeAfterLock,
  transactionWithRetry,
  type Database,
} from '../../../platform/database/database.js';
import { movement, operation } from './stock-primitives.js';
import { resolveReservation } from './resolution.js';
import { appendEvent } from '../../../platform/outbox/outbox.js';

export class InventoryExpiry {
  constructor(private readonly db: Database) {}
  async expireHolds(limit = 100): Promise<number> {
    const due = await sql<{
      order_id: string;
    }>`SELECT DISTINCT order_id FROM inventory_reservations WHERE state='HELD' AND expires_at<=clock_timestamp() ORDER BY order_id LIMIT ${limit}`.execute(
      this.db,
    );
    let count = 0;
    for (const row of due.rows)
      await transactionWithRetry(this.db, async (tx) => {
        const lock = await sql<{
          locked: boolean;
        }>`SELECT pg_try_advisory_xact_lock(hashtextextended(${`inventory-order:${row.order_id}`},0)) AS locked`.execute(
          tx,
        );
        if (!lock.rows[0]?.locked) return;
        await resolveReservation(tx, row.order_id, 'EXPIRE');
        count++;
      });
    return count;
  }
  async emitDueAlerts(limit = 100): Promise<number> {
    const due = await sql<{
      store_id: string;
      variant_id: string;
    }>`SELECT i.store_id,i.variant_id FROM store_inventory i JOIN inventory_saleable_availability a ON a.store_id=i.store_id AND a.variant_id=i.variant_id JOIN LATERAL (SELECT id FROM inventory_batches WHERE store_id=i.store_id AND variant_id=i.variant_id ORDER BY id LIMIT 1) first_batch ON true WHERE
      (a.available<=COALESCE((SELECT (value #>> '{}')::bigint FROM app_config WHERE key='catalogLowStockThreshold'),${INVENTORY_CONFIG_DEFAULTS.catalogLowStockThreshold}) AND NOT EXISTS(SELECT 1 FROM outbox_events e WHERE e.aggregate_type='inventory_alert' AND e.aggregate_id=first_batch.id AND e.aggregate_version=i.version AND e.event_type='inventory.low_stock'))
      OR EXISTS(SELECT 1 FROM inventory_batches b WHERE b.store_id=i.store_id AND b.variant_id=i.variant_id AND b.on_hand>0 AND b.expires_at>clock_timestamp() AND b.expires_at<=clock_timestamp()+COALESCE((SELECT (value #>> '{}')::integer FROM app_config WHERE key='inventoryExpirySoonDays'),${INVENTORY_CONFIG_DEFAULTS.inventoryExpirySoonDays})*interval '1 day' AND NOT EXISTS(SELECT 1 FROM outbox_events e WHERE e.aggregate_type='inventory_alert' AND e.aggregate_id=b.id AND e.aggregate_version=1 AND e.event_type='inventory.expiry_soon')) ORDER BY i.store_id,i.variant_id LIMIT ${limit}`.execute(
      this.db,
    );
    for (const row of due.rows)
      await this.db.transaction().execute(async (tx) => {
        const locked =
          await sql`SELECT store_id FROM store_inventory WHERE store_id=${row.store_id}::uuid AND variant_id=${row.variant_id}::uuid FOR UPDATE SKIP LOCKED`.execute(
            tx,
          );
        if (locked.rows.length) await stockAlerts(tx, row.store_id, row.variant_id);
      });
    return due.rows.length;
  }
  async writeOffExpired(limit = 100): Promise<number> {
    const candidates = await sql<{
      store_id: string;
      variant_id: string;
    }>`SELECT store_id,variant_id FROM inventory_batches WHERE on_hand>0 AND (state IN ('DAMAGED','QUARANTINED') OR expires_at<=clock_timestamp()) GROUP BY store_id,variant_id ORDER BY min(COALESCE(maintenance_checked_at,'-infinity'::timestamptz)),store_id,variant_id LIMIT ${limit}`.execute(
      this.db,
    );
    for (const candidate of candidates.rows)
      await transactionWithRetry(this.db, async (tx) => {
        const stock =
          await sql`SELECT store_id FROM store_inventory WHERE store_id=${candidate.store_id}::uuid AND variant_id=${candidate.variant_id}::uuid FOR UPDATE SKIP LOCKED`.execute(
            tx,
          );
        if (!stock.rows.length) return;
        const batches = await sql<{
          id: string;
          state: string;
          expires_at: Date | null;
          on_hand: string;
          reserved: string;
        }>`SELECT id,state,expires_at,on_hand::text,reserved::text FROM inventory_batches WHERE store_id=${candidate.store_id}::uuid AND variant_id=${candidate.variant_id}::uuid ORDER BY expires_at ASC NULLS LAST,id FOR UPDATE`.execute(
          tx,
        );
        const now = await databaseTimeAfterLock(tx);
        for (const batch of batches.rows) {
          if (batch.state === 'ACTIVE' && (!batch.expires_at || batch.expires_at > now)) continue;
          const reference = `writeoff:${uuidV7()}`;
          let operationCreated = false;
          const ensureOperation = async () => {
            if (!operationCreated) {
              await operation(tx, reference, 'EXPIRY_WRITEOFF', { batchId: batch.id });
              operationCreated = true;
            }
          };
          const allocations = await sql<{
            order_id: string;
            quantity: string;
            target_delivery_at: Date;
            min_seconds: number;
          }>`SELECT a.order_id,a.quantity::text,r.target_delivery_at,COALESCE(s.min_seconds,0) AS min_seconds FROM inventory_allocations a JOIN inventory_reservations r ON r.order_id=a.order_id AND r.store_id=a.store_id AND r.variant_id=a.variant_id JOIN catalog_variants v ON v.id=a.variant_id JOIN catalog_products p ON p.id=v.product_id LEFT JOIN inventory_category_shelf_life s ON s.category_id=p.category_id WHERE a.batch_id=${batch.id}::uuid AND r.state<>'RESOLVED' ORDER BY a.order_id FOR UPDATE OF a,r`.execute(
            tx,
          );
          for (const allocation of allocations.rows) {
            let remaining = BigInt(allocation.quantity);
            for (const target of batches.rows) {
              if (
                target.id === batch.id ||
                target.state !== 'ACTIVE' ||
                (target.expires_at &&
                  target.expires_at.getTime() <=
                    Math.max(now.getTime(), allocation.target_delivery_at.getTime()) +
                      allocation.min_seconds * 1000)
              )
                continue;
              const available = BigInt(target.on_hand) - BigInt(target.reserved);
              const take = remaining < available ? remaining : available;
              if (take <= 0n) continue;
              await sql`UPDATE inventory_allocations SET quantity=quantity-${take.toString()}::bigint WHERE order_id=${allocation.order_id}::uuid AND store_id=${candidate.store_id}::uuid AND variant_id=${candidate.variant_id}::uuid AND batch_id=${batch.id}::uuid AND quantity>${take.toString()}::bigint`.execute(
                tx,
              );
              if (take === remaining)
                await sql`DELETE FROM inventory_allocations WHERE order_id=${allocation.order_id}::uuid AND store_id=${candidate.store_id}::uuid AND variant_id=${candidate.variant_id}::uuid AND batch_id=${batch.id}::uuid AND quantity=${take.toString()}::bigint`.execute(
                  tx,
                );
              await sql`INSERT INTO inventory_allocations(order_id,store_id,variant_id,batch_id,quantity) VALUES(${allocation.order_id}::uuid,${candidate.store_id}::uuid,${candidate.variant_id}::uuid,${target.id}::uuid,${take.toString()}::bigint) ON CONFLICT(order_id,store_id,variant_id,batch_id) DO UPDATE SET quantity=inventory_allocations.quantity+EXCLUDED.quantity`.execute(
                tx,
              );
              await ensureOperation();
              await movement(tx, {
                reference,
                storeId: candidate.store_id,
                variantId: candidate.variant_id,
                batchId: batch.id,
                kind: 'REALLOCATE',
                onHand: 0n,
                reserved: -take,
              });
              await movement(tx, {
                reference,
                storeId: candidate.store_id,
                variantId: candidate.variant_id,
                batchId: target.id,
                kind: 'REALLOCATE',
                onHand: 0n,
                reserved: take,
              });
              batch.reserved = (BigInt(batch.reserved) - take).toString();
              target.reserved = (BigInt(target.reserved) + take).toString();
              remaining -= take;
              if (!remaining) break;
            }
            if (remaining > 0n)
              await sql`INSERT INTO inventory_shortfall_obligations(id,order_id,store_id,variant_id,batch_id,quantity,reason) VALUES(${uuidV7()}::uuid,${allocation.order_id}::uuid,${candidate.store_id}::uuid,${candidate.variant_id}::uuid,${batch.id}::uuid,${remaining.toString()}::bigint,${batch.state === 'DAMAGED' ? 'DAMAGED' : batch.state === 'QUARANTINED' ? 'QUARANTINED' : 'EXPIRED'}) ON CONFLICT(order_id,store_id,variant_id,batch_id,reason) DO UPDATE SET quantity=EXCLUDED.quantity,resolved_at=NULL`.execute(
                tx,
              );
            else
              await sql`UPDATE inventory_shortfall_obligations SET resolved_at=clock_timestamp() WHERE order_id=${allocation.order_id}::uuid AND batch_id=${batch.id}::uuid AND resolved_at IS NULL`.execute(
                tx,
              );
          }
          const safe =
            batch.state === 'QUARANTINED' ? 0n : BigInt(batch.on_hand) - BigInt(batch.reserved);
          if (safe > 0n) {
            await ensureOperation();
            await movement(tx, {
              reference,
              storeId: candidate.store_id,
              variantId: candidate.variant_id,
              batchId: batch.id,
              kind: batch.state === 'DAMAGED' ? 'DAMAGE' : 'EXPIRY_WRITEOFF',
              onHand: -safe,
              reserved: 0n,
            });
          }
        }
        await sql`UPDATE inventory_batches SET maintenance_checked_at=clock_timestamp() WHERE store_id=${candidate.store_id}::uuid AND variant_id=${candidate.variant_id}::uuid AND on_hand>0 AND (state IN ('DAMAGED','QUARANTINED') OR expires_at<=clock_timestamp())`.execute(
          tx,
        );
        const obligations = await sql<{
          id: string;
          order_id: string;
          batch_id: string;
          quantity: string;
          reason: string;
          event_version: string;
        }>`
          UPDATE inventory_shortfall_obligations SET published_quantity=quantity,event_version=event_version+1
          WHERE store_id=${candidate.store_id}::uuid AND variant_id=${candidate.variant_id}::uuid
            AND resolved_at IS NULL AND published_quantity<>quantity
          RETURNING id,order_id,batch_id,quantity::text,reason,event_version::text`.execute(tx);
        for (const obligation of obligations.rows)
          await appendEvent(
            tx,
            {
              eventId: uuidV7(),
              eventType: 'inventory.shortfall_detected',
              schemaVersion: 1,
              aggregateType: 'inventory_shortfall',
              aggregateId: obligation.id,
              aggregateVersion: obligation.event_version,
              occurredAt: now.toISOString(),
              correlationId: obligation.order_id,
              causationId: null,
              payload: {
                obligationId: obligation.id,
                orderId: obligation.order_id,
                storeId: candidate.store_id,
                variantId: candidate.variant_id,
                batchId: obligation.batch_id,
                quantity: obligation.quantity,
                reason: obligation.reason,
              },
            },
            ['inventory-shortfalls'],
          );
        await stockAlerts(tx, candidate.store_id, candidate.variant_id);
      });
    return candidates.rows.length;
  }
}
