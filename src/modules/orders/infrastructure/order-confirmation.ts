import { sql } from 'kysely';
import { appendEvent } from '../../../platform/outbox/outbox.js';
import { uuidV7 } from '../../../common/ids/ids.js';
import type { TransactionContext } from '../../../platform/database/database.js';
import type { AppConfig } from '../../app-config/contracts/config.js';
import { type InventoryReservations } from '../../inventory/contracts/inventory.js';
import { type CouponRedemptions } from '../../coupons/contracts/coupons.js';
import type { ConfirmationInput, OrderView } from '../contracts/orders.js';
import { OrderCodeService } from './delivery-codes.js';
import { mapOrder, PostgresOrderAggregate } from './postgres-orders.js';

/**
 * The single confirmation routine (plan 20.1/6.3): PENDING_PAYMENT ->
 * CONFIRMED commits every obligation in one transaction — reservation commit
 * (removing the payment expiry), coupon redemption commit, wallet ledger
 * finalization is the placement-time funding record, the delivery-code
 * verifier (never plaintext, D20) and the ORDER_CONFIRMED event consumed by
 * picking, dispatch and notifications. Idempotent under the order lock:
 * double captures or a raced confirm leave the first outcome standing.
 */
export class OrderConfirmationService {
  issueCodes(tx: TransactionContext, orderId: string) {
    return this.codes.issueFor(tx, orderId);
  }
  constructor(
    private readonly aggregate: PostgresOrderAggregate,
    private readonly reservations: InventoryReservations,
    private readonly coupons: CouponRedemptions,
    private readonly codes: OrderCodeService,
    private readonly config: AppConfig,
  ) {}
  async confirm(
    orderId: string,
    input: ConfirmationInput,
    tx: TransactionContext,
  ): Promise<OrderView> {
    const locked = await this.aggregate.lock(tx, orderId);
    if (!locked) throw new Error('ORDER_NOT_FOUND');
    if (locked.status === 'CONFIRMED') return this.view(tx, locked.id); // already confirmed
    if (locked.status !== 'PENDING_PAYMENT')
      throw new Error(
        locked.status === 'EXPIRED' ? 'PAYMENT_WINDOW_EXPIRED' : 'CONCURRENT_MODIFICATION',
      );
    if (input.kind === 'GATEWAY') {
      const paid =
        await sql`SELECT 1 FROM payment_capture_receipts c JOIN payment_attempts a ON a.id=c.attempt_id
        WHERE a.id=${input.attemptId}::uuid AND c.order_id=${orderId}::uuid AND c.gateway_payment_id=${input.gatewayPaymentId ?? null}
          AND c.amount_paise=${locked.amount_due_paise}::bigint AND c.currency=${locked.currency}`.execute(
          tx,
        );
      if (!paid.rows.length) throw new Error('PAYMENT_FUNDING_INVALID');
      await sql`UPDATE orders SET metadata=metadata||${JSON.stringify({ fundingPaymentId: input.gatewayPaymentId, fundingAttemptId: input.attemptId })}::jsonb
        WHERE id=${orderId}::uuid`.execute(tx);
    }
    if (input.kind === 'WALLET') {
      const funding =
        await sql`SELECT 1 FROM orders o JOIN wallet_funding_allocations f ON f.order_id=o.id
        WHERE o.id=${orderId}::uuid AND o.amount_due_paise=0 AND o.total_paise > 0
          AND f.wallet_spend_reference IS NOT NULL
          AND f.promo_paise=o.wallet_promo_paise AND f.cash_paise=o.wallet_cash_paise
          AND f.promo_paise+f.cash_paise=o.total_paise
          AND f.promo_paise = COALESCE((SELECT -sum(l.delta_paise) FROM wallet_ledger l JOIN wallet_accounts a ON a.id=l.account_id WHERE a.user_id=o.user_id AND l.ref_type='ORDER' AND l.ref_id=f.wallet_spend_reference AND l.bucket='promo' AND l.reason IN ('ORDER_PAYMENT','ORDER_PAYMENT_REVERSAL')),0)
          AND f.cash_paise = COALESCE((SELECT -sum(l.delta_paise) FROM wallet_ledger l JOIN wallet_accounts a ON a.id=l.account_id WHERE a.user_id=o.user_id AND l.ref_type='ORDER' AND l.ref_id=f.wallet_spend_reference AND l.bucket='cash' AND l.reason IN ('ORDER_PAYMENT','ORDER_PAYMENT_REVERSAL')),0)`.execute(
          tx,
        );
      if (!funding.rows.length) throw new Error('PAYMENT_FUNDING_INVALID');
    }
    const method =
      input.kind === 'COD'
        ? 'COD'
        : input.kind === 'ZERO_DUE'
          ? 'ZERO_DUE'
          : input.kind === 'WALLET'
            ? 'WALLET'
            : 'GATEWAY';
    await sql`UPDATE orders SET payment_method=${method},
      payment_status=${input.kind === 'COD' ? 'COD_PENDING' : 'PAID'}
      WHERE id=${orderId}::uuid`.execute(tx);
    const row = await this.aggregate.transition(
      tx,
      orderId,
      'PENDING_PAYMENT',
      'CONFIRMED',
      'ORDER_CONFIRMED',
      { type: 'SYSTEM', id: null },
    );
    await this.reservations.commit(orderId, tx);
    const couponReservationId =
      typeof row.metadata['couponReservationId'] === 'string'
        ? (row.metadata['couponReservationId'] as string)
        : null;
    if (couponReservationId) await this.coupons.commit(couponReservationId, orderId, tx);
    await this.codes.issueFor(tx, orderId);
    if (input.kind === 'COD')
      await sql`INSERT INTO cod_collections(id,order_id,amount_paise,expected_amount_paise) VALUES (${uuidV7()}::uuid,${orderId}::uuid,${row.amount_due_paise}::bigint,${row.amount_due_paise}::bigint)
        ON CONFLICT (order_id) DO NOTHING`.execute(tx);
    await this.emitConfirmedEvent(tx, orderId, row);
    return this.view(tx, orderId);
  }
  /** Shared with reinstatement: the P7 payload contract (parseOrderConfirmed). */
  async emitConfirmedEvent(
    tx: TransactionContext,
    orderId: string,
    row: {
      id: string;
      order_number: string;
      user_id: string;
      store_id: string;
      delivery_slot: Record<string, unknown> | null;
      placed_at: Date;
      version: string;
    },
  ): Promise<void> {
    const items = await sql<{
      id: string;
      variant_id: string;
      name_snapshot: string;
      ordered_qty: string;
    }>`SELECT id,variant_id::text AS variant_id,name_snapshot,ordered_qty::text
      FROM order_items WHERE order_id=${orderId}::uuid ORDER BY created_at,id`.execute(tx);
    const slot = row.delivery_slot as { slotStart?: string } | null;
    const targetDeliveryAt =
      slot && typeof slot.slotStart === 'string'
        ? slot.slotStart
        : new Date(row.placed_at.getTime() + 2 * 3600_000).toISOString();
    await appendEvent(
      tx,
      {
        eventId: uuidV7(),
        eventType: 'ORDER_CONFIRMED',
        schemaVersion: 1,
        aggregateType: 'order',
        aggregateId: orderId,
        aggregateVersion: row.version,
        occurredAt: new Date().toISOString(),
        correlationId: row.order_number,
        causationId: null,
        payload: {
          orderId,
          orderNumber: row.order_number,
          userId: row.user_id,
          storeId: row.store_id,
          targetDeliveryAt,
          items: items.rows.map((item) => ({
            orderItemId: item.id,
            variantId: item.variant_id,
            name: item.name_snapshot,
            quantity: item.ordered_qty,
          })),
        },
      },
      ['picking', 'dispatch', 'notifications'],
    );
  }
  private async view(tx: TransactionContext, orderId: string): Promise<OrderView> {
    const row = await this.aggregate.lock(tx, orderId);
    if (!row) throw new Error('ORDER_NOT_FOUND');
    return mapOrder(row, [], (row.metadata['fees'] as never as []) ?? []);
  }
}
