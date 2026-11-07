import { sql } from 'kysely';
import { uuidV7 } from '../../../common/ids/ids.js';
import type { TransactionContext } from '../../../platform/database/database.js';
import type { EventEnvelope } from '../../../platform/outbox/outbox.js';
import type { AppConfig } from '../../app-config/contracts/config.js';
import type { OrderConfirmedPayload } from '../contracts/fulfillment.js';
import { slaDueAt } from '../domain/sla.js';
import { operation, taskHistory } from './pick-primitives.js';

const UUID = /^[0-9a-f-]{36}$/i;

/** Strict payload validation; malformed confirmations retry and eventually suspend. */
export function parseOrderConfirmed(payload: unknown): OrderConfirmedPayload {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload))
    throw new Error('UNPARSEABLE_EVENT');
  const p = payload as Record<string, unknown>;
  if (
    typeof p.orderId !== 'string' ||
    !UUID.test(p.orderId) ||
    typeof p.storeId !== 'string' ||
    !UUID.test(p.storeId) ||
    typeof p.orderNumber !== 'string' ||
    p.orderNumber.length < 1 ||
    p.orderNumber.length > 40 ||
    typeof p.targetDeliveryAt !== 'string' ||
    Number.isNaN(new Date(p.targetDeliveryAt).getTime()) ||
    !Array.isArray(p.items) ||
    p.items.length < 1 ||
    p.items.length > 500
  )
    throw new Error('UNPARSEABLE_EVENT');
  const items = p.items.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry))
      throw new Error('UNPARSEABLE_EVENT');
    const item = entry as Record<string, unknown>;
    if (
      typeof item.orderItemId !== 'string' ||
      !UUID.test(item.orderItemId) ||
      typeof item.variantId !== 'string' ||
      !UUID.test(item.variantId) ||
      typeof item.name !== 'string' ||
      item.name.length < 1 ||
      item.name.length > 300 ||
      typeof item.quantity !== 'string' ||
      !/^[1-9][0-9]{0,18}$/.test(item.quantity)
    )
      throw new Error('UNPARSEABLE_EVENT');
    return {
      orderItemId: item.orderItemId,
      variantId: item.variantId,
      name: item.name,
      quantity: item.quantity,
    };
  });
  return {
    orderId: p.orderId,
    orderNumber: p.orderNumber,
    userId: typeof p.userId === 'string' && UUID.test(p.userId) ? p.userId : '',
    storeId: p.storeId,
    targetDeliveryAt: p.targetDeliveryAt,
    items,
  };
}

/**
 * Idempotent ORDER_CONFIRMED consumer: one active pick task per order
 * (SYS-06), protected by both the delivery dedupe and the partial unique
 * index on active tasks.
 */
export class OrderConfirmedConsumer {
  constructor(private readonly config: AppConfig) {}
  async handle(tx: TransactionContext, event: EventEnvelope): Promise<void> {
    if (event.eventType !== 'ORDER_CONFIRMED') return;
    const payload = parseOrderConfirmed(event.payload);
    if (!(await operation(tx, `confirm:${event.eventId}`, 'ORDER_CONFIRMED', payload))) return;
    const minutes = await this.config.get('pickingSlaMinutes');
    const now = await sql<{ now: Date }>`SELECT clock_timestamp() AS now`.execute(tx);
    const due = slaDueAt(now.rows[0]!.now, minutes);
    const taskId = uuidV7();
    await sql`INSERT INTO pick_tasks(id,order_id,store_id,status,sla_due_at) VALUES(${taskId}::uuid,${payload.orderId}::uuid,${payload.storeId}::uuid,'PENDING',${due.toISOString()}::timestamptz)`.execute(
      tx,
    );
    for (const item of payload.items)
      await sql`INSERT INTO pick_items(id,task_id,order_item_id,variant_id,name_snapshot,expected_qty,status) VALUES(${uuidV7()}::uuid,${taskId}::uuid,${item.orderItemId}::uuid,${item.variantId}::uuid,${item.name},${item.quantity}::bigint,'PENDING')`.execute(
        tx,
      );
    await taskHistory(tx, taskId, null, 'PENDING', null);
  }
}
