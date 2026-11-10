import { sql } from 'kysely';
import { uuidV7 } from '../../../common/ids/ids.js';
import { transactionWithRetry, type Database } from '../../../platform/database/database.js';
import type { IdentityAccess } from '../../identity/contracts/identity.js';
import type { InventoryReturns } from '../../inventory/contracts/returns.js';
import type { OrderDelivery } from '../contracts/dependencies.js';
import type { DeliveryReturn, ReturnItem } from '../contracts/tasks.js';
import { loadTask, lockOrder, operation, releaseRiderTask, taskEvent } from './primitives.js';

export class ReturnToStore implements DeliveryReturn {
  constructor(
    private readonly db: Database,
    private readonly identity: IdentityAccess,
    private readonly inventory: InventoryReturns,
    private readonly orders: OrderDelivery,
  ) {}
  async receive(
    actorId: string,
    orderId: string,
    reason: string,
    items: ReturnItem[],
    reference: string,
  ): Promise<{ returnIds: string[] }> {
    if (
      !reason.trim() ||
      reason.length > 300 ||
      !reference ||
      reference.length > 150 ||
      !items.length ||
      items.length > 100
    )
      throw new Error('INVALID_INPUT');
    if (
      new Set(items.map((i) => i.variantId)).size !== items.length ||
      items.some((i) => !/^[1-9]\d*$/.test(i.quantity))
    )
      throw new Error('INVALID_INPUT');
    return transactionWithRetry(this.db, async (tx) => {
      const order = await lockOrder(tx, orderId);
      const projection = await sql<{
        id: string;
        store_id: string;
      }>`SELECT id,store_id FROM delivery_tasks WHERE order_id=${orderId}::uuid ORDER BY created_at DESC LIMIT 1`.execute(
        tx,
      );
      const selected = projection.rows[0];
      if (
        !order ||
        !selected ||
        !(await this.identity.hasStoreRole(actorId, selected.store_id, ['STORE_MANAGER'], tx))
      )
        throw new Error('RESOURCE_NOT_FOUND');
      if (
        !(await operation(tx, `rto:${orderId}:${reference}`, 'RETURN_TO_STORE', {
          actorId,
          orderId,
          reason,
          items,
        }))
      ) {
        const existing = await sql<{
          id: string;
        }>`SELECT id FROM inventory_returns WHERE order_id=${orderId}::uuid ORDER BY id`.execute(
          tx,
        );
        return { returnIds: existing.rows.map((r) => r.id) };
      }
      if (order.status !== 'DELIVERY_FAILED') throw new Error('TASK_STATE_INVALID');
      const expected = await sql<{
        variant_id: string;
        quantity: string;
      }>`SELECT COALESCE(fulfillment_snapshot->>'variantId',variant_id::text) AS variant_id,sum(fulfilled_qty)::text AS quantity
        FROM order_items WHERE order_id=${orderId}::uuid AND fulfilled_qty>0
        GROUP BY COALESCE(fulfillment_snapshot->>'variantId',variant_id::text) ORDER BY variant_id`.execute(
        tx,
      );
      const sorted = [...items].sort((a, b) => a.variantId.localeCompare(b.variantId));
      if (
        expected.rows.length !== sorted.length ||
        sorted.some(
          (i, n) =>
            i.variantId !== expected.rows[n]!.variant_id ||
            i.quantity !== expected.rows[n]!.quantity,
        )
      )
        throw new Error('RETURN_QUANTITY_MISMATCH');
      const ids: string[] = [];
      for (const item of sorted) {
        const returnId = uuidV7();
        await this.inventory.receiveReturn(
          actorId,
          { returnId, orderId, storeId: selected.store_id, ...item },
          tx,
        );
        ids.push(returnId);
      }
      const task = await loadTask(tx, selected.id, true);
      if (!task || task.status !== 'FAILED' || !task.rider_id)
        throw new Error('TASK_STATE_INVALID');
      await this.orders.markReturnedToStore(orderId, actorId, reason, tx);
      await releaseRiderTask(tx, task.rider_id, new Date());
      await sql`UPDATE delivery_tasks SET rider_id=NULL,custody_released_at=clock_timestamp(),version=version+1 WHERE id=${task.id}::uuid`.execute(
        tx,
      );
      await taskEvent(
        tx,
        task.id,
        orderId,
        'delivery.returned_to_store',
        { riderId: task.rider_id, storeId: selected.store_id, returnIds: ids, reason },
        ['notifications'],
      );
      return { returnIds: ids };
    });
  }
}
