import { sql } from 'kysely';
import {
  transactionWithRetry,
  type Database,
  type TransactionContext,
} from '../../../platform/database/database.js';
import { type InventoryReservations } from '../../inventory/contracts/inventory.js';
import { type CouponRedemptions } from '../../coupons/contracts/coupons.js';
import { type WalletFunding, type WalletSpender } from '../../wallet/contracts/wallet.js';
import type { CapacityClaims } from '../../serviceability/contracts/serviceability.js';
import type {
  Actor,
  AdminOrderFilter,
  ConfirmationInput,
  CreateOrderInput,
  JsonRecord,
  OrderListPage,
  OrderOperations,
  OrderStatus,
  OrderView,
  ReorderResult,
} from '../contracts/orders.js';
import { evaluateCancellation, reinstatable } from '../domain/cancellation-policy.js';
import { FORCE_STATE_ALLOWED } from '../domain/order-policy.js';
import { OrderCompensationService } from './order-compensation.js';
import { OrderConfirmationService } from './order-confirmation.js';
import { OrderMutationsService } from './order-queries.js';
import { PostgresOrderAggregate, adminFilterWhere, listPage, mapOrder } from './postgres-orders.js';

function viewOf(
  row: Awaited<ReturnType<PostgresOrderAggregate['byIdRaw']>>,
  items: Awaited<ReturnType<PostgresOrderAggregate['items']>>,
): OrderView {
  if (!row) throw new Error('ORDER_NOT_FOUND');
  return mapOrder(row, items, (row.metadata['fees'] as OrderView['fees']) ?? []);
}

/**
 * Order operations (P6.4): every mutation takes the order row lock first and
 * records history in the same transaction; cancellation and expiry share the
 * one compensation routine; force-state is a guarded repair channel (D25),
 * never an arbitrary status write.
 */
export class OrderService implements OrderOperations {
  readonly compensation: OrderCompensationService;
  constructor(
    private readonly db: Database,
    private readonly aggregate: PostgresOrderAggregate,
    private readonly confirmation: OrderConfirmationService,
    compensation: OrderCompensationService,
    private readonly reservations: InventoryReservations,
    private readonly coupons: CouponRedemptions,
    private readonly wallet: WalletSpender,
    private readonly funding: WalletFunding,
    private readonly mutations: OrderMutationsService,
    private readonly capacity?: CapacityClaims,
  ) {
    this.compensation = compensation;
  }
  async create(input: CreateOrderInput): Promise<OrderView> {
    await this.aggregate.insert(input.tx, input);
    const row = await this.aggregate.lock(input.tx, input.orderId);
    return viewOf(row, await this.aggregate.items(input.orderId, input.tx));
  }
  async confirm(orderId: string, input: ConfirmationInput, tx: TransactionContext) {
    return this.confirmation.confirm(orderId, input, tx);
  }
  async byId(
    orderId: string,
    opts?: { userId?: string; tx?: TransactionContext },
  ): Promise<OrderView | null> {
    const row = await this.aggregate.byIdRaw(orderId, opts?.tx);
    if (!row || (opts?.userId && row.user_id !== opts.userId)) return null;
    return viewOf(row, await this.aggregate.items(orderId, opts?.tx));
  }
  async transition(
    orderId: string,
    expectedStatus: OrderStatus,
    next: OrderStatus,
    action: string,
    actor: Actor,
    opts?: { reason?: string; tx?: TransactionContext },
  ): Promise<OrderView> {
    const run = (tx: TransactionContext) =>
      this.aggregate.transition(tx, orderId, expectedStatus, next, action, actor, opts?.reason);
    const row = opts?.tx ? await run(opts.tx) : await transactionWithRetry(this.db, run);
    return viewOf(row, await this.aggregate.items(orderId, opts?.tx));
  }
  async cancel(
    orderId: string,
    actor: Actor,
    reason: string,
    opts?: { tx?: TransactionContext },
  ): Promise<OrderView> {
    if (!reason.trim() || reason.length > 300) throw new Error('INVALID_INPUT');
    const run = async (tx: TransactionContext) => {
      const row = await this.aggregate.lock(tx, orderId);
      if (!row) throw new Error('ORDER_NOT_FOUND');
      if (row.status === 'CANCELLED') return viewOf(row, await this.aggregate.items(orderId, tx));
      if (actor.type === 'CUSTOMER') {
        const locked =
          await sql`SELECT 1 FROM orders o JOIN subscription_occurrences occ ON occ.order_id=o.id
          WHERE o.id=${orderId}::uuid AND o.source='SUBSCRIPTION' AND clock_timestamp() >=
          (((occ.delivery_date-1) + COALESCE((SELECT value #>> '{}' FROM app_config WHERE key='subscriptionCutoffTime'),'21:00')::time) AT TIME ZONE 'Asia/Kolkata')`.execute(
            tx,
          );
        if (locked.rows.length) throw new Error('CUTOFF_PASSED');
      }

      const verdict = evaluateCancellation(row.status, actor.type);
      if (!verdict.allowed) throw new Error(verdict.code);
      await this.aggregate.transition(
        tx,
        orderId,
        row.status,
        'CANCELLED',
        'ORDER_CANCELLED',
        actor,
        reason,
      );
      await this.compensation.compensate(
        orderId,
        { reason, actor, refundCaptured: verdict.refund },
        tx,
      );
      const fresh = await this.aggregate.lock(tx, orderId);
      return viewOf(fresh, await this.aggregate.items(orderId, tx));
    };
    return opts?.tx ? run(opts.tx) : transactionWithRetry(this.db, run);
  }
  /** Same-zone, fee-preserving, pre-PICKING address change (GEO-03). */
  async changeAddress(
    orderId: string,
    userId: string,
    input: { addressId: string; addressSnapshot: JsonRecord },
  ): Promise<OrderView> {
    await this.mutations.changeAddress(orderId, userId, {
      addressId: input.addressId,
      addressSnapshot: input.addressSnapshot,
    });
    const row = await this.aggregate.byIdRaw(orderId);
    return viewOf(row, await this.aggregate.items(orderId));
  }
  async reorder(
    orderId: string,
    userId: string,
    opts?: { tx?: TransactionContext },
  ): Promise<ReorderResult> {
    return this.mutations.reorder(orderId, userId, opts?.tx);
  }
  async expireDue(limit: number): Promise<number> {
    const due = await sql<{ id: string }>`SELECT id FROM orders
      WHERE status='PENDING_PAYMENT' AND expires_at IS NOT NULL AND expires_at <= clock_timestamp()
      ORDER BY expires_at LIMIT ${limit} FOR UPDATE SKIP LOCKED`.execute(this.db);
    let expired = 0;
    for (const row of due.rows) {
      const done = await transactionWithRetry(this.db, async (tx) => {
        const locked = await this.aggregate.lock(tx, row.id);
        if (!locked || locked.status !== 'PENDING_PAYMENT') return false;
        await this.aggregate.transition(
          tx,
          row.id,
          'PENDING_PAYMENT',
          'EXPIRED',
          'ORDER_EXPIRED',
          {
            type: 'SYSTEM',
            id: null,
          },
          'PAYMENT_WINDOW_EXPIRED',
        );
        await this.compensation.compensate(
          row.id,
          {
            reason: 'PAYMENT_EXPIRED',
            actor: { type: 'SYSTEM', id: null },
            refundCaptured: false,
          },
          tx,
        );
        return true;
      }).catch(() => false);
      if (done) expired += 1;
    }
    return expired;
  }
  async timeline(orderId: string, opts?: { userId?: string }) {
    const row = await this.aggregate.byIdRaw(orderId);
    if (!row || (opts?.userId && row.user_id !== opts.userId)) throw new Error('ORDER_NOT_FOUND');
    const entries = await this.aggregate.timelineRows(orderId);
    return opts?.userId
      ? entries.map((entry) =>
          ['ORDER_HELD', 'ORDER_RESUMED'].includes(entry.action)
            ? { ...entry, reason: null }
            : entry,
        )
      : entries;
  }
  async expirePending(orderId: string, tx: TransactionContext): Promise<boolean> {
    const row = await this.aggregate.lock(tx, orderId);
    const due =
      await sql`SELECT id FROM orders WHERE id=${orderId}::uuid AND status='PENDING_PAYMENT' AND expires_at<=clock_timestamp()`.execute(
        tx,
      );
    if (!row || !due.rows.length) return false;
    await this.aggregate.transition(
      tx,
      orderId,
      'PENDING_PAYMENT',
      'EXPIRED',
      'ORDER_EXPIRED',
      { type: 'SYSTEM', id: null },
      'PAYMENT_WINDOW_EXPIRED',
    );
    await this.compensation.compensate(
      orderId,
      { reason: 'PAYMENT_EXPIRED', actor: { type: 'SYSTEM', id: null }, refundCaptured: false },
      tx,
    );
    return true;
  }
  async list(userId: string, limit: number, cursor?: string): Promise<OrderListPage> {
    return listPage(this.db, sql`user_id=${userId}::uuid`, limit, cursor);
  }
  async adminList(
    filter: AdminOrderFilter,
    limit: number,
    cursor?: string,
  ): Promise<OrderListPage> {
    return listPage(this.db, adminFilterWhere(filter), limit, cursor);
  }
  /**
   * Reinstatement (plan 6.4): ONLY system-expired orders, ONLY with the flag
   * on, and every obligation is reacquired before the order re-enters
   * CONFIRMED — stock re-reserve+commit, coupon re-reserve+commit, wallet
   * re-debit with a fresh spend reference. Any failure rolls the whole
   * reinstatement back so the late capture is refunded instead.
   */
  async reinstate(orderId: string, actor: Actor, tx?: TransactionContext): Promise<OrderView> {
    const run = (ctx: TransactionContext) => this.reinstateIn(ctx, orderId, actor);
    return tx ? run(tx) : transactionWithRetry(this.db, run);
  }
  private async reinstateIn(
    tx: TransactionContext,
    orderId: string,
    actor: Actor,
  ): Promise<OrderView> {
    const row = await this.aggregate.lock(tx, orderId);
    if (!row) throw new Error('ORDER_NOT_FOUND');
    const flags = await sql<{ enabled: boolean }>`SELECT enabled FROM feature_flags
        WHERE key='reinstate_expired_orders'`.execute(tx);
    if (flags.rows[0]?.enabled !== true) throw new Error('ILLEGAL_STATE_TRANSITION');
    if (!reinstatable(row.status, row.cancel_reason !== null))
      throw new Error('ILLEGAL_STATE_TRANSITION');
    const referralClaimId =
      typeof row.metadata['referralClaimId'] === 'string' ? row.metadata['referralClaimId'] : null;
    if (referralClaimId) {
      const claimed = await sql`UPDATE referral_claims SET redeemed_order_id=${orderId}::uuid
        WHERE id=${referralClaimId}::uuid AND friend_id=${row.user_id}::uuid AND redeemed_order_id IS NULL RETURNING id`.execute(
        tx,
      );
      if (!claimed.rows.length) throw new Error('RESOURCE_CONFLICT');
    }
    const items = await sql<{
      variant_id: string;
      ordered_qty: string;
    }>`SELECT variant_id::text AS variant_id,ordered_qty::text
        FROM order_items WHERE order_id=${orderId}::uuid ORDER BY created_at,id`.execute(tx);
    if (
      !this.capacity ||
      (await this.capacity.claim(row.store_id, new Date(), orderId, tx)) === 'AT_CAPACITY'
    )
      throw new Error('ADDRESS_NOT_SERVICEABLE');
    await this.reservations.reserve(
      {
        orderId,
        cycleReference: `${orderId}:reinstate`,
        lines: items.rows.map((item) => ({
          storeId: row.store_id,
          variantId: item.variant_id,
          quantity: item.ordered_qty,
        })),
        targetDeliveryAt: new Date(Date.now() + 2 * 3600_000).toISOString(),
        ttlSeconds: 900,
      },
      tx,
    );
    await this.reservations.commit(orderId, tx);
    const walletTotal = BigInt(row.wallet_promo_paise) + BigInt(row.wallet_cash_paise);
    if (walletTotal > 0n) {
      const spent = await this.wallet.spend(
        row.user_id,
        `${orderId}:reinstate`,
        walletTotal.toString(),
        tx,
        {
          promoCapBps: row.wallet_promo_paise === '0' ? 0 : 10000,
        },
      );
      await this.funding.record({
        orderId,
        walletSpendReference: walletTotal > 0n ? `${orderId}:reinstate` : undefined,
        promoPaise: spent.promoPaise,
        cashPaise: spent.cashPaise,
        tx,
      });
    }
    const couponCode =
      typeof row.metadata['couponCode'] === 'string'
        ? (row.metadata['couponCode'] as string)
        : null;
    if (couponCode) {
      const reservationId = await this.coupons.reserve(couponCode, row.user_id, tx);
      await this.coupons.commit(reservationId, orderId, tx);
    }
    await sql`UPDATE orders SET status='CONFIRMED',payment_status='PAID',version=version+1,
        confirmed_at=clock_timestamp(),updated_at=clock_timestamp(),expires_at=NULL
        WHERE id=${orderId}::uuid AND status='EXPIRED'`.execute(tx);
    await this.aggregate.history(
      tx,
      orderId,
      'EXPIRED',
      'CONFIRMED',
      'ORDER_REINSTATED',
      actor,
      'LATE_CAPTURE_REINSTATE',
    );
    const fresh = await this.aggregate.lock(tx, orderId);
    if (!fresh) throw new Error('ORDER_NOT_FOUND');
    await this.confirmation.issueCodes(tx, orderId);
    await this.confirmation.emitConfirmedEvent(tx, orderId, fresh);
    return viewOf(fresh, await this.aggregate.items(orderId, tx));
  }
  async forceState(
    orderId: string,
    next: OrderStatus,
    reason: string,
    adminId: string,
    outer?: TransactionContext,
  ): Promise<OrderView> {
    if (!reason) throw new Error('INVALID_INPUT');
    const run = async (tx: TransactionContext) => {
      const row = await this.aggregate.lock(tx, orderId);
      if (!row) throw new Error('ORDER_NOT_FOUND');
      if (!FORCE_STATE_ALLOWED[row.status].includes(next))
        throw new Error('ILLEGAL_STATE_TRANSITION');
      if (next === 'CANCELLED')
        return this.cancel(orderId, { type: 'ADMIN', id: adminId }, reason, { tx });
      if (next !== 'EXPIRED') throw new Error('ILLEGAL_STATE_TRANSITION');
      const updated = await this.aggregate.transition(
        tx,
        orderId,
        row.status,
        next,
        'ORDER_FORCE_STATE',
        {
          type: 'ADMIN',
          id: adminId,
        },
        reason,
      );
      await this.compensation.compensate(
        orderId,
        { reason, actor: { type: 'ADMIN', id: adminId }, refundCaptured: false },
        tx,
      );
      return viewOf(updated, await this.aggregate.items(orderId, tx));
    };
    return outer ? run(outer) : transactionWithRetry(this.db, run);
  }
}
