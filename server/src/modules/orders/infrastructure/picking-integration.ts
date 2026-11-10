import { sql } from 'kysely';
import { uuidV7 } from '../../../common/ids/ids.js';
import {
  transactionWithRetry,
  type Database,
  type TransactionContext,
} from '../../../platform/database/database.js';
import type { PaymentRefundOperations } from '../../payments/contracts/payments.js';
interface AdjustmentSummary {
  refundedPaise: string;
  creditNoteRequired: boolean;
}
interface ShortAdjustmentLine {
  orderItemId: string;
  shortQty: string;
  reason: string;
  substituteVariantId?: string;
}
interface StoreOrderSummary {
  orderId: string;
  orderNumber: string | null;
  status: string;
  itemCount: number;
  placedAt: string | null;
  pickTaskId: string | null;
  pickTaskStatus: string | null;
}
import { OrderService } from './order-service.js';
import { priceFulfillment, type FulfillmentSource } from './fulfillment-pricing.js';

export interface FulfillmentLine {
  orderItemId: string;
  variantId: string;
  fulfilledQty: string;
  shortQty: string;
  reason?: string;
  substituteVariantId?: string;
}

/** Picking ports backed by the order aggregate and source-capped refund commitments. */
export class OrderPickingIntegration {
  constructor(
    private readonly db: Database,
    private readonly orders: OrderService,
    private readonly refunds: PaymentRefundOperations,
  ) {}
  async startPicking(orderId: string, actorId: string, tx?: TransactionContext): Promise<void> {
    if ((await this.orders.byId(orderId, { tx }))?.status === 'PICKING') return;
    await this.orders.transition(
      orderId,
      'CONFIRMED',
      'PICKING',
      'PICKING_STARTED',
      { type: 'PICKER', id: actorId },
      { tx },
    );
  }
  async markPacked(orderId: string, actorId: string, tx?: TransactionContext): Promise<void> {
    await this.orders.transition(
      orderId,
      'PICKING',
      'PACKED',
      'ORDER_PACKED',
      { type: 'PICKER', id: actorId },
      { tx },
    );
  }
  async systemCancel(orderId: string, reason: string, tx?: TransactionContext): Promise<void> {
    await this.orders.cancel(orderId, { type: 'SYSTEM', id: null }, reason, { tx });
  }
  async orderSummary(orderId: string): Promise<StoreOrderSummary | null> {
    const rows = await sql<{
      order_id: string;
      order_number: string;
      status: string;
      item_count: string;
      placed_at: Date;
      pick_task_id: string | null;
      pick_task_status: string | null;
    }>`SELECT o.id::text AS order_id,o.order_number,o.status,o.placed_at,
      (SELECT count(*)::text FROM order_items i WHERE i.order_id=o.id) AS item_count,
      p.id::text AS pick_task_id,p.status AS pick_task_status FROM orders o
      LEFT JOIN LATERAL (SELECT id,status FROM pick_tasks WHERE order_id=o.id ORDER BY created_at DESC LIMIT 1) p ON true
      WHERE o.id=${orderId}::uuid`.execute(this.db);
    const row = rows.rows[0];
    return row
      ? {
          orderId: row.order_id,
          orderNumber: row.order_number,
          status: row.status,
          itemCount: Number(row.item_count),
          placedAt: row.placed_at.toISOString(),
          pickTaskId: row.pick_task_id,
          pickTaskStatus: row.pick_task_status,
        }
      : null;
  }
  async storeOrders(
    storeId: string,
    cursor?: string,
    limit = 50,
  ): Promise<{ items: StoreOrderSummary[]; nextCursor: string | null }> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('INVALID_PAGE');
    const rows = await sql<{
      id: string;
    }>`SELECT id::text FROM orders WHERE store_id=${storeId}::uuid AND (${cursor ?? null}::uuid IS NULL OR id < ${cursor ?? null}::uuid) ORDER BY id DESC LIMIT ${limit}`.execute(
      this.db,
    );
    const items = (await Promise.all(rows.rows.map((r) => this.orderSummary(r.id)))).filter(
      (v): v is StoreOrderSummary => v !== null,
    );
    return { items, nextCursor: rows.rows.length === limit ? rows.rows.at(-1)!.id : null };
  }
  async recordShort(input: {
    orderId: string;
    actorId: string;
    lines: ShortAdjustmentLine[];
    tx?: TransactionContext;
  }): Promise<AdjustmentSummary> {
    const run = async (tx: TransactionContext) => {
      const rows = await sql<{
        id: string;
        variant_id: string;
        ordered_qty: string;
      }>`SELECT id::text,variant_id::text,ordered_qty::text FROM order_items WHERE order_id=${input.orderId}::uuid`.execute(
        tx,
      );
      const lines = rows.rows.map((r) => {
        const short = input.lines.find((l) => l.orderItemId === r.id);
        return {
          orderItemId: r.id,
          variantId: r.variant_id,
          fulfilledQty: (BigInt(r.ordered_qty) - BigInt(short?.shortQty ?? '0')).toString(),
          shortQty: short?.shortQty ?? '0',
          reason: short?.reason,
          substituteVariantId: short?.substituteVariantId,
        };
      });
      return this.settleFulfillment({ ...input, lines, tx });
    };
    return input.tx ? run(input.tx) : transactionWithRetry(this.db, run);
  }
  async settleFulfillment(input: {
    orderId: string;
    actorId: string;
    lines: FulfillmentLine[];
    tx?: TransactionContext;
  }): Promise<AdjustmentSummary> {
    const run = async (tx: TransactionContext) => {
      const order = await sql<{
        id: string;
        total_paise: string;
        payment_method: string | null;
        store_id: string;
      }>`SELECT id::text,total_paise::text,payment_method,store_id FROM orders WHERE id=${input.orderId}::uuid FOR UPDATE`.execute(
        tx,
      );
      if (!order.rows[0]) throw new Error('ORDER_NOT_FOUND');
      const items = await sql<
        FulfillmentSource & {
          id: string;
          variant_id: string;
          ordered_qty: string;
          unit_price_paise: string;
          discount_paise: string;
          line_status: string;
        }
      >`SELECT id::text,variant_id::text,ordered_qty::text,unit_price_paise::text,discount_paise::text,line_status,
        name_snapshot,hsn_code,mrp_paise::text,tax_rate_bps FROM order_items WHERE order_id=${input.orderId}::uuid ORDER BY id FOR UPDATE`.execute(
        tx,
      );
      if (
        items.rows.length !== input.lines.length ||
        new Set(input.lines.map((l) => l.orderItemId)).size !== items.rows.length
      )
        throw new Error('INVALID_INPUT');
      if (items.rows.every((i) => i.line_status !== 'PENDING'))
        return { refundedPaise: '0', creditNoteRequired: false };
      let reduction = 0n;
      for (const item of items.rows) {
        const line = input.lines.find((l) => l.orderItemId === item.id);
        if (
          !line ||
          line.variantId !== item.variant_id ||
          !/^\d+$/.test(line.fulfilledQty) ||
          !/^\d+$/.test(line.shortQty)
        )
          throw new Error('INVALID_INPUT');
        const quantity = BigInt(item.ordered_qty),
          fulfilled = BigInt(line.fulfilledQty),
          short = BigInt(line.shortQty);
        if (fulfilled + short !== quantity) throw new Error('INVALID_INPUT');
        const final = await priceFulfillment(
          tx,
          item,
          line.fulfilledQty,
          order.rows[0].store_id,
          line.substituteVariantId,
        );
        reduction += final.reduction;
        await sql`UPDATE order_items SET fulfillment_snapshot=${JSON.stringify(final.snapshot)}::jsonb,fulfilled_qty=${line.fulfilledQty}::bigint,short_qty=${line.shortQty}::bigint,line_status=${short === 0n ? 'FULFILLED' : fulfilled === 0n ? 'SHORT' : 'PARTIAL'} WHERE id=${item.id}::uuid`.execute(
          tx,
        );
      }
      if (reduction > BigInt(order.rows[0].total_paise)) throw new Error('INVALID_MONEY');
      if (reduction > 0n) {
        await sql`INSERT INTO order_adjustments(id,order_id,kind,amount_paise,reason,adjustment_reference,created_by) VALUES (${uuidV7()}::uuid,${input.orderId}::uuid,'SHORT_REFUND',${reduction.toString()}::bigint,'FULFILLMENT_SHORT','fulfillment',${input.actorId}::uuid)`.execute(
          tx,
        );
        let remaining = reduction;
        for (const source of await this.refunds.refundableCapacity(input.orderId, tx)) {
          if (remaining <= 0n) break;
          const available = BigInt(source.availablePaise),
            amount = available < remaining ? available : remaining;
          if (amount <= 0n) continue;
          await this.refunds.commit({
            refundReference: `fulfillment:${input.orderId}:${source.sourceType}:${source.sourceId}`,
            orderId: input.orderId,
            sourceType: source.sourceType,
            sourceId: source.sourceId,
            amountPaise: amount.toString(),
            destination: source.sourceType === 'GATEWAY_CAPTURE' ? 'GATEWAY' : 'WALLET',
            gatewayPaymentId: source.sourceType === 'GATEWAY_CAPTURE' ? source.sourceId : undefined,
            reason: 'FULFILLMENT_SHORT',
            initiatedBy: input.actorId,
            tx,
          });
          remaining -= amount;
        }
        if (remaining > 0n && order.rows[0].payment_method !== 'COD')
          throw new Error('REFUND_LIMIT_EXCEEDED');
        if (remaining > 0n)
          await sql`UPDATE cod_collections SET expected_amount_paise=GREATEST(0,expected_amount_paise-${remaining.toString()}::bigint),amount_paise=GREATEST(0,amount_paise-${remaining.toString()}::bigint), version=version+1 WHERE order_id=${input.orderId}::uuid AND state='PENDING'`.execute(
            tx,
          );
      }
      return { refundedPaise: reduction.toString(), creditNoteRequired: reduction > 0n };
    };
    return input.tx ? run(input.tx) : transactionWithRetry(this.db, run);
  }
}
