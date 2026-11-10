import { sql } from 'kysely';
import type { TransactionContext } from '../../../platform/database/database.js';
import type { EventEnvelope } from '../../../platform/outbox/outbox.js';
import type { OrderCancellation } from '../contracts/fulfillment.js';
import type { PickCancellation } from '../contracts/tasks.js';

/** Revalidate the durable obligation after locking its order before compensating. */
export class InventoryShortfallConsumer {
  constructor(
    private readonly orders: OrderCancellation,
    private readonly picking: PickCancellation,
  ) {}

  async handle(tx: TransactionContext, event: EventEnvelope): Promise<void> {
    if (event.eventType !== 'inventory.shortfall_detected') return;
    const payload = event.payload as { orderId?: string; obligationId?: string } | null;
    if (!payload?.orderId || !payload.obligationId) throw new Error('UNPARSEABLE_EVENT');
    const order = await sql<{
      status: string;
    }>`SELECT status FROM orders WHERE id=${payload.orderId}::uuid FOR UPDATE`.execute(tx);
    const obligation = await sql`SELECT id FROM inventory_shortfall_obligations
      WHERE id=${payload.obligationId}::uuid AND order_id=${payload.orderId}::uuid AND resolved_at IS NULL`.execute(
      tx,
    );
    if (
      !obligation.rows.length ||
      !order.rows[0] ||
      ['CANCELLED', 'EXPIRED', 'RETURNED_TO_STORE', 'DELIVERED'].includes(order.rows[0].status)
    )
      return;
    await this.orders.systemCancel(payload.orderId, 'STOCK_SHORTFALL', tx);
    await this.picking.cancel(payload.orderId, 'STOCK_SHORTFALL', tx);
  }
}
