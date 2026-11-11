import { sql } from 'kysely';
import { appendEvent } from '../../../platform/outbox/outbox.js';
import { uuidV7 } from '../../../common/ids/ids.js';
import {
  transactionWithRetry,
  type Database,
  type TransactionContext,
} from '../../../platform/database/database.js';
import { type InventoryReservations } from '../../inventory/contracts/inventory.js';
import { type CouponRedemptions } from '../../coupons/contracts/coupons.js';
import {
  type PaymentRefundOperations,
  type RefundSourceType,
} from '../../payments/contracts/payments.js';
import { type WalletSpender } from '../../wallet/contracts/wallet.js';
import type { CapacityClaims } from '../../serviceability/contracts/serviceability.js';
import type { InventoryReturns } from '../../inventory/contracts/returns.js';
import type { Actor } from '../contracts/orders.js';
import { PostgresOrderAggregate } from './postgres-orders.js';

export interface CompensationInput {
  reason: string;
  actor: Actor;
  /** Cancel-after-capture refunds the funded amounts to their sources. */
  refundCaptured: boolean;
  returnedToStore?: boolean;
}
interface StagedRefund {
  refundReference: string;
  sourceType: RefundSourceType;
}

/**
 * The ONE shared compensation routine (plan 6.3/20.3/21; ADD-13): reverse the
 * wallet allocation once, release only outstanding stock and coupon
 * obligations, and reserve the external refund amount before initiating it.
 * Every effect is idempotent — wallet reversal and adjustment rows carry
 * durable references, refunds are capacity-checked commitments, releases are
 * state-guarded — so expiry, cancellation and late-capture races converge on
 * one consistent outcome. Gateway refunds dispatch only after the commit.
 */
export class OrderCompensationService {
  constructor(
    private readonly db: Database,
    private readonly aggregate: PostgresOrderAggregate,
    private readonly reservations: InventoryReservations,
    private readonly coupons: CouponRedemptions,
    private readonly refunds: PaymentRefundOperations,
    private readonly wallet: WalletSpender,
    private readonly capacity?: CapacityClaims,
    private readonly returns?: InventoryReturns,
  ) {}
  async compensate(
    orderId: string,
    input: CompensationInput,
    outer?: TransactionContext,
  ): Promise<void> {
    const staged = outer
      ? await this.runIn(outer, orderId, input)
      : await transactionWithRetry(this.db, (tx) => this.runIn(tx, orderId, input));
    for (const refund of outer ? [] : staged)
      if (refund.sourceType === 'GATEWAY_CAPTURE')
        await this.refunds.dispatchRefund(refund.refundReference).catch(() => undefined);
  }
  private async runIn(
    tx: TransactionContext,
    orderId: string,
    input: CompensationInput,
  ): Promise<StagedRefund[]> {
    const row = await this.aggregate.lock(tx, orderId);
    if (!row) throw new Error('ORDER_NOT_FOUND');
    if (input.refundCaptured && !input.returnedToStore) {
      if (!this.returns) throw new Error('FULFILLMENT_DEPENDENCY_UNAVAILABLE');
      await this.returns.receiveCancelledOrder(orderId, input.actor.id, tx);
    }
    if (!input.refundCaptured) await this.reverseWallet(tx, row);
    if (!input.returnedToStore) await this.releaseStock(tx, orderId);
    await this.capacity?.release(orderId, tx);
    await this.releaseCoupon(tx, row);
    if (!input.returnedToStore)
      await sql`UPDATE referral_claims SET redeemed_order_id=NULL WHERE redeemed_order_id=${orderId}::uuid`.execute(
        tx,
      );
    const staged = input.refundCaptured ? await this.reserveRefunds(tx, row, input.reason) : [];
    for (const entry of staged)
      await sql`INSERT INTO order_adjustments(id,order_id,kind,amount_paise,reason,adjustment_reference,created_by)
        VALUES (${uuidV7()}::uuid,${orderId}::uuid,'CANCELLATION_REFUND',${entry.amountPaise}::bigint,${input.reason},
          ${uuidV7()},${input.actor.id}::uuid)`.execute(tx);
    if (!input.returnedToStore)
      await appendEvent(
        tx,
        {
          eventId: uuidV7(),
          eventType: 'ORDER_CANCELLED',
          schemaVersion: 1,
          aggregateType: 'order',
          aggregateId: orderId,
          aggregateVersion: row.version,
          occurredAt: new Date().toISOString(),
          correlationId: row.order_number,
          causationId: null,
          payload: {
            orderId,
            reason: input.reason,
            actorType: input.actor.type,
            actorId: input.actor.id,
          },
        },
        ['picking', 'dispatch', 'notifications'],
      );
    return staged.map((entry) => ({
      refundReference: entry.refundReference,
      sourceType: entry.sourceType,
    }));
  }
  private async reverseWallet(
    tx: TransactionContext,
    row: { id: string; wallet_promo_paise: string; wallet_cash_paise: string },
  ): Promise<void> {
    if (row.wallet_promo_paise === '0' && row.wallet_cash_paise === '0') return;
    await this.wallet.reverseSpend(row.id, tx);
  }
  private async releaseStock(tx: TransactionContext, orderId: string): Promise<void> {
    const held = await sql<{ state: string }>`SELECT state FROM inventory_reservations
      WHERE order_id=${orderId}::uuid`.execute(tx);
    if (!held.rows.some((row) => row.state === 'HELD' || row.state === 'COMMITTED')) return;
    await this.reservations.release(orderId, tx);
  }
  private async releaseCoupon(
    tx: TransactionContext,
    row: { metadata: Record<string, unknown> },
  ): Promise<void> {
    const reservationId =
      typeof row.metadata['couponReservationId'] === 'string'
        ? (row.metadata['couponReservationId'] as string)
        : null;
    if (!reservationId) return;
    try {
      await this.coupons.release(reservationId, tx);
    } catch (error: unknown) {
      // Committed redemptions cannot be un-counted against global/per-user
      // quotas; cancel-after-confirm keeps the use while money is refunded.
      if ((error as Error).message !== 'RESOURCE_CONFLICT') throw error;
    }
  }
  /**
   * Reserves one refund per funded source under the order lock (ADD-13:
   * pending+processed+unknown commitments count against capacity). The
   * gateway share stays reserved until the provider outcome lands.
   */
  private async reserveRefunds(
    tx: TransactionContext,
    row: { id: string },
    reason: string,
  ): Promise<{ refundReference: string; sourceType: RefundSourceType; amountPaise: string }[]> {
    const capacities = await this.refunds.refundableCapacity(row.id, tx);
    const staged: { refundReference: string; sourceType: RefundSourceType; amountPaise: string }[] =
      [];
    for (const capacity of capacities) {
      if (capacity.availablePaise === '0') continue;
      const view = await this.refunds.commit({
        orderId: row.id,
        sourceType: capacity.sourceType,
        sourceId: capacity.sourceId,
        amountPaise: capacity.availablePaise,
        destination: capacity.sourceType === 'GATEWAY_CAPTURE' ? 'GATEWAY' : 'WALLET',
        reason,
        tx,
        gatewayPaymentId: capacity.sourceType === 'GATEWAY_CAPTURE' ? capacity.sourceId : undefined,
      });
      staged.push({
        refundReference: view.refundReference,
        sourceType: capacity.sourceType,
        amountPaise: view.amountPaise,
      });
    }
    return staged;
  }
}
