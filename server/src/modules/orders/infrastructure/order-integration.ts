import { sql } from 'kysely';
import type { TransactionContext } from '../../../platform/database/database.js';
import type {
  OrderDelivery,
  OrderDeliveryReads,
  OrderDeliverySummary,
  OrderSystemCancel,
} from '../../dispatch/contracts/dependencies.js';
import type { Actor } from '../contracts/orders.js';
import { PostgresOrderAggregate } from './postgres-orders.js';
import { OrderService } from './order-service.js';

/**
 * Integration adapters binding the P8 dispatch dependency ports (ADR 0011)
 * to the P6 order aggregate. Everything delegates to the same guarded
 * transitions and the ONE shared compensation/cancel routine, so custody and
 * money can never diverge: markDelivered/markDeliveryFailed are normal
 * locked transitions; systemCancel is the shared cancel routine with the
 * SYSTEM actor.
 */
export class OrderIntegrationService
  implements OrderDeliveryReads, OrderDelivery, OrderSystemCancel
{
  constructor(
    private readonly orders: OrderService,
    private readonly aggregate: PostgresOrderAggregate,
  ) {}
  async orderSummary(orderId: string): Promise<OrderDeliverySummary | null> {
    const row = await this.aggregate.byIdRaw(orderId);
    if (!row) return null;
    const cod =
      row.payment_method === 'COD'
        ? await sql<{
            amount: string;
          }>`SELECT COALESCE(expected_amount_paise,amount_paise)::text AS amount FROM cod_collections WHERE order_id=${orderId}::uuid`.execute(
            this.aggregate.database(),
          )
        : null;
    return {
      orderId: row.id,
      orderNumber: row.order_number,
      userId: row.user_id,
      storeId: row.store_id,
      status: row.status,
      paymentMethod: (row.payment_method ?? null) as OrderDeliverySummary['paymentMethod'],
      amountDuePaise: cod?.rows[0]?.amount ?? row.amount_due_paise,
      tipPaise: row.tip_paise,
      addressSnapshot: row.address_snapshot as OrderDeliverySummary['addressSnapshot'],
    };
  }
  async markPickedUp(orderId: string, actorId: string, tx?: TransactionContext): Promise<void> {
    await this.orders.transition(
      orderId,
      'PACKED',
      'OUT_FOR_DELIVERY',
      'ORDER_PICKED_UP',
      { type: 'RIDER', id: actorId },
      { tx },
    );
  }
  async markReturnedToStore(
    orderId: string,
    actorId: string,
    reason: string,
    tx?: TransactionContext,
  ): Promise<void> {
    if (!tx) throw new Error('TRANSACTION_REQUIRED');
    const actor: Actor = { type: 'STORE_MANAGER', id: actorId };
    await this.orders.transition(
      orderId,
      'DELIVERY_FAILED',
      'RETURNED_TO_STORE',
      'ORDER_RETURNED_TO_STORE',
      actor,
      { reason, tx },
    );
    await this.orders.compensation.compensate(
      orderId,
      { reason, actor, refundCaptured: true, returnedToStore: true },
      tx,
    );
  }
  async markDelivered(orderId: string, actorId: string, tx?: TransactionContext): Promise<void> {
    const actor: Actor = { type: 'RIDER', id: actorId };
    await this.orders.transition(
      orderId,
      'OUT_FOR_DELIVERY',
      'DELIVERED',
      'ORDER_DELIVERED',
      actor,
      { tx },
    );
  }
  async markDeliveryFailed(
    orderId: string,
    actorId: string,
    reason: string,
    _evidence: Record<string, string> | undefined,
    tx?: TransactionContext,
    actorType: 'RIDER' | 'ADMIN' = 'RIDER',
  ): Promise<void> {
    const actor: Actor = { type: actorType, id: actorId };
    await this.orders.transition(
      orderId,
      'OUT_FOR_DELIVERY',
      'DELIVERY_FAILED',
      'DELIVERY_FAILED',
      actor,
      {
        reason,
        tx,
      },
    );
  }
  /** The shared compensation-backed cancel (stock/coupon/wallet/refunds). */
  async systemCancel(orderId: string, reason: string, tx?: TransactionContext): Promise<void> {
    await this.orders.cancel(orderId, { type: 'SYSTEM', id: null }, reason, { tx });
  }
}
