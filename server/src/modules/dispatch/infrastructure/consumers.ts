import { sql } from 'kysely';
import { uuidV7 } from '../../../common/ids/ids.js';
import type { TransactionContext } from '../../../platform/database/database.js';
import type { EventEnvelope } from '../../../platform/outbox/outbox.js';
import type { AppConfig } from '../../app-config/contracts/config.js';
import type { OrderConfirmedPayload } from '../../picking/contracts/fulfillment.js';
import type { DeliveryCodes } from '../contracts/tasks.js';
import type { DispatchTrigger } from '../domain/settings.js';
import { operation, taskHistory } from './primitives.js';

const UUID = /^[0-9a-f-]{36}$/i;

/** Strict payload validation (mirrors the P6 producer contract). */
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
    !Array.isArray(p.items)
  )
    throw new Error('UNPARSEABLE_EVENT');
  return {
    orderId: p.orderId,
    orderNumber: p.orderNumber,
    userId: typeof p.userId === 'string' && UUID.test(p.userId) ? p.userId : '',
    storeId: p.storeId,
    targetDeliveryAt:
      typeof p.targetDeliveryAt === 'string' ? p.targetDeliveryAt : new Date().toISOString(),
    items: [],
  };
}

/**
 * Idempotent ORDER_CONFIRMED consumer: one active delivery task per order
 * (SYS-06, partial unique index) plus the D20 delivery-code issue. The task
 * stays queued (`next_dispatch_at = infinity`) until the configured dispatch
 * trigger releases it.
 */
export class OrderConfirmedConsumer {
  constructor(
    private readonly config: AppConfig,
    private readonly codes: DeliveryCodes,
  ) {}
  async handle(tx: TransactionContext, event: EventEnvelope): Promise<void> {
    if (event.eventType !== 'ORDER_CONFIRMED') return;
    const payload = parseOrderConfirmed(event.payload);
    const order = await sql<{
      status: string;
      source: string;
    }>`SELECT status,source FROM orders WHERE id=${payload.orderId}::uuid FOR UPDATE`.execute(tx);
    if (!order.rows[0] || !['CONFIRMED', 'PICKING', 'PACKED'].includes(order.rows[0].status))
      return;
    if (!(await operation(tx, `confirm:${event.eventId}`, 'ORDER_CONFIRMED', payload))) return;
    const lead =
      order.rows[0].source === 'SUBSCRIPTION'
        ? await this.config.get('subscriptionDispatchLeadMinutes', tx)
        : 0;
    const notBefore =
      order.rows[0].source === 'SUBSCRIPTION'
        ? new Date(new Date(payload.targetDeliveryAt).getTime() - lead * 60000).toISOString()
        : null;
    const taskId = uuidV7();
    const inserted =
      await sql`INSERT INTO delivery_tasks(id,order_id,store_id,customer_user_id,status,next_dispatch_at,dispatch_not_before)
      VALUES(${taskId}::uuid,${payload.orderId}::uuid,${payload.storeId}::uuid,${payload.userId || null}::uuid,'UNASSIGNED','infinity'::timestamptz,COALESCE(${notBefore}::timestamptz,'-infinity'::timestamptz))
      ON CONFLICT DO NOTHING RETURNING id`.execute(tx);
    if (!inserted.rows.length) return;
    const created = await sql<{
      id: string;
    }>`SELECT id FROM delivery_tasks WHERE order_id=${payload.orderId}::uuid ORDER BY created_at DESC LIMIT 1`.execute(
      tx,
    );
    if (!created.rows[0]) return;
    await taskHistory(tx, created.rows[0].id, null, 'UNASSIGNED', null, 'order confirmed');
    await this.codes.issue(payload.orderId, tx);
  }
}

/**
 * Dispatch trigger consumer (23.2.1): ON_PICK_START consumes
 * `picking.task_changed` with status IN_PROGRESS; ON_PACKED consumes
 * ORDER_PACKED from packing. Releasing the task is a
 * transactional next_dispatch_at update; the periodic sweep performs dispatch.
 */
export class PickTriggerConsumer {
  constructor(private readonly trigger: () => Promise<DispatchTrigger>) {}
  async handle(tx: TransactionContext, event: EventEnvelope): Promise<void> {
    const mode = await this.trigger();
    if (mode === 'ON_PICK_START') {
      if (event.eventType !== 'picking.task_changed') return;
      const payload = event.payload as { status?: unknown };
      if (payload?.status !== 'IN_PROGRESS') return;
    } else if (event.eventType !== 'ORDER_PACKED') {
      return;
    }
    const orderId =
      (event.payload as { orderId?: unknown }).orderId ?? event.correlationId ?? event.aggregateId;
    if (typeof orderId !== 'string' || !UUID.test(orderId)) return;
    await sql`UPDATE delivery_tasks SET next_dispatch_at=clock_timestamp()
      WHERE order_id=${orderId}::uuid AND status='UNASSIGNED' AND next_dispatch_at='infinity'::timestamptz`.execute(
      tx,
    );
  }
}
