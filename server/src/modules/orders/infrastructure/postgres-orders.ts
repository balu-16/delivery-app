import { sql } from 'kysely';
import { uuidV7 } from '../../../common/ids/ids.js';
import {
  databaseTimeAfterLock,
  type Database,
  type TransactionContext,
} from '../../../platform/database/database.js';
import type {
  Actor,
  AdminOrderFilter,
  CreateOrderInput,
  OrderFeeLine,
  OrderItemView,
  OrderListPage,
  OrderStatus,
  OrderView,
  TimelineEntry,
} from '../contracts/orders.js';
import { transitionOrderStatus } from '../domain/order-policy.js';

interface OrderRow {
  id: string;
  order_number: string;
  user_id: string;
  store_id: string;
  address_snapshot: Record<string, unknown>;
  status: OrderStatus;
  on_hold: boolean;
  payment_status: string;
  payment_method: string | null;
  currency: string;
  subtotal_paise: string;
  discount_paise: string;
  fee_total_paise: string;
  tax_total_paise: string;
  tip_paise: string;
  total_paise: string;
  wallet_promo_paise: string;
  wallet_cash_paise: string;
  amount_due_paise: string;
  delivery_slot: Record<string, unknown> | null;
  placed_at: Date;
  expires_at: Date | null;
  confirmed_at: Date | null;
  delivered_at: Date | null;
  cancelled_at: Date | null;
  cancel_reason: string | null;
  metadata: Record<string, unknown>;
  version: string;
}
const COLUMNS = `id,order_number,user_id,store_id,address_snapshot,status,on_hold,payment_status,payment_method,currency,
  subtotal_paise::text,discount_paise::text,fee_total_paise::text,tax_total_paise::text,tip_paise::text,total_paise::text,
  wallet_promo_paise::text,wallet_cash_paise::text,amount_due_paise::text,delivery_slot,placed_at,expires_at,confirmed_at,
  delivered_at,cancelled_at,cancel_reason,metadata,version::text AS version`;

export function mapOrder(
  row: OrderRow,
  items: readonly OrderItemView[],
  metadataFees: readonly OrderFeeLine[],
): OrderView {
  return {
    orderId: row.id,
    orderNumber: row.order_number,
    userId: row.user_id,
    storeId: row.store_id,
    status: row.status,
    onHold: row.on_hold,
    paymentStatus: row.payment_status as OrderView['paymentStatus'],
    paymentMethod: (row.payment_method ?? null) as OrderView['paymentMethod'],
    subtotalPaise: row.subtotal_paise,
    discountPaise: row.discount_paise,
    feeTotalPaise: row.fee_total_paise,
    taxTotalPaise: row.tax_total_paise,
    tipPaise: row.tip_paise,
    totalPaise: row.total_paise,
    walletPromoPaise: row.wallet_promo_paise,
    walletCashPaise: row.wallet_cash_paise,
    amountDuePaise: row.amount_due_paise,
    currency: row.currency,
    placedAt: row.placed_at.toISOString(),
    expiresAt: row.expires_at?.toISOString() ?? null,
    confirmedAt: row.confirmed_at?.toISOString() ?? null,
    deliveredAt: row.delivered_at?.toISOString() ?? null,
    cancelReason: row.cancel_reason,
    items,
    fees: metadataFees,
    metadata: row.metadata,
    version: row.version,
  };
}

export function newOrderNumber(): string {
  return `ORD-${uuidV7().replaceAll('-', '').toUpperCase()}`;
}

/** Core aggregate primitives; every mutation takes the order row lock first. */
export class PostgresOrderAggregate {
  constructor(private readonly db: Database) {}
  database(): Database {
    return this.db;
  }
  async insert(tx: TransactionContext, input: CreateOrderInput): Promise<void> {
    await sql`INSERT INTO orders(id,order_number,user_id,store_id,address_snapshot,metadata,status,payment_status,
      subtotal_paise,discount_paise,fee_total_paise,tax_total_paise,tip_paise,total_paise,source,
      wallet_promo_paise,wallet_cash_paise,amount_due_paise,delivery_slot,placed_at,expires_at)
      VALUES (${input.orderId}::uuid,${input.orderNumber ?? newOrderNumber()},${input.userId}::uuid,${input.storeId}::uuid,
        ${JSON.stringify(input.addressSnapshot)}::jsonb,${JSON.stringify(input.metadata)}::jsonb,'PENDING_PAYMENT','UNPAID',
        ${input.subtotalPaise}::bigint,${input.discountPaise}::bigint,${input.feeTotalPaise}::bigint,
        ${input.taxTotalPaise}::bigint,${input.tipPaise}::bigint,${input.totalPaise}::bigint,${input.source ?? 'CUSTOMER'},
        ${input.walletPromoPaise}::bigint,${input.walletCashPaise}::bigint,${input.amountDuePaise}::bigint,
        ${input.deliverySlot ? JSON.stringify(input.deliverySlot) : null}::jsonb,clock_timestamp(),
        ${input.expiresAt}::timestamptz)`.execute(tx);
    for (const item of input.items)
      await sql`INSERT INTO order_items(id,order_id,variant_id,name_snapshot,ordered_qty,unit_price_paise,
        mrp_paise,discount_paise,tax_paise,tax_rate_bps,hsn_code)
        VALUES (${uuidV7()}::uuid,${input.orderId}::uuid,${item.variantId}::uuid,${item.nameSnapshot},
          ${item.orderedQty}::bigint,${item.unitPricePaise}::bigint,${item.mrpPaise}::bigint,
          ${item.discountPaise}::bigint,${item.taxPaise}::bigint,${item.taxRateBps},${item.hsnCode})`.execute(
        tx,
      );
    await this.history(tx, input.orderId, null, 'PENDING_PAYMENT', 'ORDER_PLACED', {
      type: 'CUSTOMER',
      id: input.userId,
    });
  }
  async history(
    tx: TransactionContext,
    orderId: string,
    previous: string | null,
    state: string,
    action: string,
    actor: Actor,
    reason?: string,
  ): Promise<void> {
    await sql`INSERT INTO order_status_history(id,order_id,previous_state,state,action,actor_type,actor_id,reason)
      VALUES (${uuidV7()}::uuid,${orderId}::uuid,${previous},${state},${action},${actor.type},
        ${actor.id}::uuid,${reason ?? null})`.execute(tx);
  }
  async lock(tx: TransactionContext, orderId: string): Promise<OrderRow | null> {
    const rows = await sql<OrderRow>`SELECT ${sql.raw(COLUMNS)} FROM orders
      WHERE id=${orderId}::uuid FOR UPDATE`.execute(tx);
    return rows.rows[0] ?? null;
  }
  async items(orderId: string, tx?: TransactionContext): Promise<OrderItemView[]> {
    const rows = await sql<{
      id: string;
      variant_id: string;
      name_snapshot: string;
      ordered_qty: string;
      fulfilled_qty: string;
      short_qty: string;
      unit_price_paise: string;
      tax_paise: string;
      line_status: string;
    }>`SELECT id,variant_id::text AS variant_id,name_snapshot,ordered_qty::text,fulfilled_qty::text,
      short_qty::text,unit_price_paise::text,tax_paise::text,line_status
      FROM order_items WHERE order_id=${orderId}::uuid ORDER BY created_at,id`.execute(
      tx ?? this.db,
    );
    return rows.rows.map((row) => ({
      id: row.id,
      variantId: row.variant_id,
      name: row.name_snapshot,
      orderedQty: row.ordered_qty,
      fulfilledQty: row.fulfilled_qty,
      shortQty: row.short_qty,
      unitPricePaise: row.unit_price_paise,
      taxPaise: row.tax_paise,
      lineStatus: row.line_status,
    }));
  }
  async byIdRaw(orderId: string, tx?: TransactionContext): Promise<OrderRow | null> {
    const rows = await sql<OrderRow>`SELECT ${sql.raw(COLUMNS)} FROM orders
      WHERE id=${orderId}::uuid`.execute(tx ?? this.db);
    return rows.rows[0] ?? null;
  }
  /** Guarded transition committing state + history in the caller's transaction. */
  async transition(
    tx: TransactionContext,
    orderId: string,
    expectedStatus: OrderStatus,
    next: OrderStatus,
    action: string,
    actor: Actor,
    reason?: string,
  ): Promise<OrderRow> {
    const locked = await this.lock(tx, orderId);
    if (!locked) throw new Error('ORDER_NOT_FOUND');
    if (locked.status !== expectedStatus)
      throw new Error(terminalOf(locked.status) ?? 'CONCURRENT_MODIFICATION');
    const now = await databaseTimeAfterLock(tx);
    const checked = transitionOrderStatus(expectedStatus, next);
    const updated = await sql<OrderRow>`UPDATE orders SET status=${checked},version=version+1,
      updated_at=clock_timestamp(),
      confirmed_at=CASE WHEN ${checked}='CONFIRMED' THEN ${now.toISOString()}::timestamptz ELSE confirmed_at END,
      delivered_at=CASE WHEN ${checked}='DELIVERED' THEN ${now.toISOString()}::timestamptz ELSE delivered_at END,
      cancelled_at=CASE WHEN ${checked}='CANCELLED' THEN ${now.toISOString()}::timestamptz ELSE cancelled_at END,
      cancel_reason=CASE WHEN ${checked}='CANCELLED' THEN ${reason ?? null} ELSE cancel_reason END,
      expires_at=CASE WHEN ${checked}='CONFIRMED' THEN NULL ELSE expires_at END
      WHERE id=${orderId}::uuid AND version=${locked.version}::bigint RETURNING ${sql.raw(COLUMNS)}`.execute(
      tx,
    );
    const row = updated.rows[0]!;
    await this.history(tx, orderId, expectedStatus, checked, action, actor, reason);
    return row;
  }
  async timelineRows(orderId: string): Promise<TimelineEntry[]> {
    const rows = await sql<{
      previous_state: string | null;
      state: string;
      action: string;
      actor_type: string;
      actor_id: string | null;
      reason: string | null;
      created_at: Date;
    }>`SELECT previous_state,state,action,actor_type,actor_id::text AS actor_id,reason,created_at
      FROM order_status_history WHERE order_id=${orderId}::uuid ORDER BY created_at,id`.execute(
      this.db,
    );
    return rows.rows.map((row) => ({
      previousState: row.previous_state,
      state: row.state,
      action: row.action,
      actorType: row.actor_type,
      actorId: row.actor_id,
      reason: row.reason,
      at: row.created_at.toISOString(),
    }));
  }
}

export function terminalOf(status: OrderStatus): string | undefined {
  return status === 'CANCELLED'
    ? 'ILLEGAL_STATE_TRANSITION'
    : status === 'EXPIRED'
      ? 'PAYMENT_WINDOW_EXPIRED'
      : undefined;
}

const PAGE_LIMIT = 100;

/** Opaque keyset cursor over (placed_at, id) descending. */
export function encodeOrderCursor(row: { placed_at: Date; id: string }): string {
  return Buffer.from(`${row.placed_at.toISOString()}|${row.id}`, 'utf8').toString('base64url');
}
export function decodeOrderCursor(cursor: string): { at: string; id: string } | null {
  try {
    const [at, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
    if (!at || !id || !/^\d{4}-\d{2}-\d{2}T/.test(at)) return null;
    return { at, id };
  } catch {
    return null;
  }
}

export async function listPage(
  db: Database,
  where: ReturnType<typeof sql>,
  limit: number,
  cursor?: string,
): Promise<OrderListPage> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > PAGE_LIMIT)
    throw new Error('INVALID_PAGE');
  const after = cursor ? decodeOrderCursor(cursor) : null;
  if (cursor && !after) throw new Error('INVALID_PAGE');
  const rows = await sql<OrderRow & { id: string }>`SELECT ${sql.raw(COLUMNS)} FROM orders
    WHERE ${where}
    ${after ? sql`AND (placed_at,id) < (${after.at}::timestamptz,${after.id}::uuid)` : sql``}
    ORDER BY placed_at DESC,id DESC LIMIT ${limit}`.execute(db);
  const last = rows.rows[rows.rows.length - 1];
  return {
    items: rows.rows.map((row) =>
      mapOrder(row, [], (row.metadata['fees'] as OrderFeeLine[] | undefined) ?? []),
    ),
    nextCursor: rows.rows.length === limit && last ? encodeOrderCursor(last) : null,
  };
}

export function adminFilterWhere(filter: AdminOrderFilter): ReturnType<typeof sql> {
  return sql`TRUE
    ${filter.status ? sql`AND status=${filter.status}` : sql``}
    ${filter.storeId ? sql`AND store_id=${filter.storeId}::uuid` : sql``}
    ${filter.userId ? sql`AND user_id=${filter.userId}::uuid` : sql``}
    ${filter.placedAfter ? sql`AND placed_at >= ${filter.placedAfter}::timestamptz` : sql``}`;
}
