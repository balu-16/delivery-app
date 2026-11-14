import { sql } from 'kysely';
import {
  IdempotencyStore,
  type IdempotencyOwner,
} from '../../../common/idempotency/idempotency.js';
import { lockActiveCustomer } from '../../identity/contracts/account-lock.js';
import { transactionWithRetry, type Database } from '../../../platform/database/database.js';
import type { ConfigService } from '../../../config/config.service.js';
import type { CartIntents } from '../../cart/contracts/intent.js';
import type { CartQuotes } from '../../cart/contracts/quote.js';
import type { Serviceability } from '../../serviceability/contracts/serviceability.js';
import type { CapacityClaims } from '../../serviceability/contracts/serviceability.js';
import type { CouponRedemptions } from '../../coupons/contracts/coupons.js';
import type { InventoryReservations } from '../../inventory/contracts/inventory.js';
import type { WalletFunding, WalletSpender } from '../../wallet/contracts/wallet.js';
import type {
  PaymentIntent,
  PaymentOrderOperations,
  PaymentFraudSignals,
} from '../../payments/contracts/payments.js';
import type { OrderOperations, OrderView } from '../../orders/contracts/orders.js';
import type { AppConfig } from '../../app-config/contracts/config.js';
import type {
  CheckoutOperations,
  CheckoutPaymentView,
  CheckoutPlaceRequest,
  CheckoutPlaceResult,
  CheckoutQuoteRequest,
  CheckoutQuoteResult,
} from '../contracts/checkout.js';
import { codEligibility } from './cod-eligibility.js';
import { PlaceOrderSaga } from './place-order.js';
import { ScheduledOrderService } from './scheduled-order.js';
import type { ScheduledOrderInput } from '../contracts/checkout.js';
import type { TransactionContext } from '../../../platform/database/database.js';

/** Everything checkout needs from its sibling provider modules. */
export interface CheckoutDependencies {
  readonly intents: CartIntents;
  readonly quotes: CartQuotes;
  readonly serviceability: Serviceability;
  readonly capacity: CapacityClaims;
  readonly coupons: CouponRedemptions;
  readonly wallet: WalletSpender;
  readonly funding: WalletFunding;
  readonly inventory: InventoryReservations;
  readonly orders: OrderOperations;
  readonly paymentOrders: PaymentOrderOperations;
  readonly config: AppConfig;
}

/**
 * Checkout orchestration (P6.3). `quote` re-prices the cart with real wallet
 * balances (when the wallet is enabled) and issues the expiring intent.
 * `place` runs the placement saga inside one transaction, then performs the
 * durable gateway setup strictly after the commit; a crash between the two
 * resumes the SAME order through the idempotency operation id.
 */
export class CheckoutService implements CheckoutOperations {
  private readonly saga: PlaceOrderSaga;
  constructor(
    private readonly db: Database,
    private readonly deps: CheckoutDependencies,
    private readonly env: ConfigService,
    private readonly fraud?: PaymentFraudSignals,
  ) {
    this.saga = new PlaceOrderSaga({ ...deps, db });
  }
  priceScheduled(input: ScheduledOrderInput, tx: TransactionContext) {
    return new ScheduledOrderService(this.deps).price(input, tx);
  }
  async priceScheduledBatch(inputs: readonly ScheduledOrderInput[]) {
    const output: ({ unitPricePaise: string; totalPaise: string } | null)[] = [];
    // Keep transactions and their shared locks short; a failed estimate must not
    // abort estimates for other deliveries in the same batch.
    for (let offset = 0; offset < inputs.length; offset += 20) {
      const chunk = inputs.slice(offset, offset + 20);
      const results = await this.db
        .transaction()
        .execute(async (tx) => {
          const scheduled = new ScheduledOrderService(this.deps, true);
          const values: ({ unitPricePaise: string; totalPaise: string } | null)[] = [];
          for (const input of chunk) {
            await sql`SAVEPOINT scheduled_estimate`.execute(tx);
            try {
              values.push(await scheduled.price(input, tx));
            } catch {
              await sql`ROLLBACK TO SAVEPOINT scheduled_estimate`.execute(tx);
              scheduled.clearEstimateCache();
              values.push(null);
            }
            await sql`RELEASE SAVEPOINT scheduled_estimate`.execute(tx);
          }
          return values;
        })
        .catch(() => chunk.map(() => null));
      output.push(...results);
    }
    return output;
  }
  placeScheduled(input: ScheduledOrderInput, tx: TransactionContext) {
    return new ScheduledOrderService(this.deps).place(input, tx);
  }
  async quote(userId: string, input: CheckoutQuoteRequest): Promise<CheckoutQuoteResult> {
    const wallet = await this.walletInput(userId);
    const quote = await this.deps.quotes.refresh({
      userId,
      addressId: input.addressId,
      tipPaise: input.tipPaise,
      couponCode: input.couponCode ?? undefined,
      wallet,
    });
    const intent = await this.deps.intents.issue(quote.cartId, quote.cartVersion, quote.quoteId);
    const codAvailable =
      BigInt(quote.amountDuePaise) === 0n ||
      (await this.canPayCash(userId, quote.storeId, quote.amountDuePaise));
    return { quote, intentId: intent.intentId, intentExpiresAt: intent.expiresAt, codAvailable };
  }
  private async canPayCash(
    userId: string,
    storeId: string,
    amountDuePaise: string,
  ): Promise<boolean> {
    return (await codEligibility(this.db, this.deps.config, userId, storeId, amountDuePaise))
      .allowed;
  }
  async place(
    userId: string,
    input: CheckoutPlaceRequest,
    owner?: IdempotencyOwner,
  ): Promise<CheckoutPlaceResult> {
    if (
      owner &&
      (owner.operationId !== input.idempotencyOperationId || owner.scope.actor !== userId)
    )
      throw new Error('IDEMPOTENCY_LEASE_LOST');
    const resumable = await this.saga.findResumable(input.idempotencyOperationId);
    if (resumable) return this.resume(userId, resumable);
    const idempotency = owner ? new IdempotencyStore(this.db) : undefined;
    const outcome = await transactionWithRetry(this.db, async (tx) => {
      if (owner) await idempotency!.lockOwner(tx, owner);
      await lockActiveCustomer(userId, tx);
      const existing = await this.saga.findResumable(input.idempotencyOperationId, tx);
      if (existing) {
        if (owner) await idempotency!.extendLocked(tx, owner);
        return { existing } as const;
      }
      const placed = await this.saga.place(userId, input, tx);
      if (owner) await idempotency!.extendLocked(tx, owner);
      return { placed } as const;
    });
    if (outcome.existing) return this.resume(userId, outcome.existing);
    const placed = outcome.placed;
    const payment = placed.attempt ? await this.setupPayment(placed.attempt) : null;
    await this.fraud?.recordCheckoutVelocity(userId, placed.order.orderId).catch(() => undefined);
    return {
      order: placed.order,
      payment,
      confirmation: placed.confirmed ? 'CONFIRMED' : 'PENDING_PAYMENT',
    };
  }
  async completePaymentSetup(
    operationReference: string,
    receipt: string,
  ): Promise<CheckoutPaymentView | null> {
    const attempt = await this.deps.paymentOrders.intentByOperationReference(operationReference);
    if (!attempt) return null;
    return this.toPaymentView(
      await this.deps.paymentOrders.completeSetup(operationReference, receipt),
    );
  }
  /** Re-drives gateway setup for the latest attempt of a resumed placement. */
  private async resume(userId: string, order: OrderView): Promise<CheckoutPlaceResult> {
    if (order.userId !== userId) throw new Error('RESOURCE_NOT_FOUND');
    const attempts = await this.deps.paymentOrders.listAttempts(order.orderId);
    const latest = attempts[attempts.length - 1];
    let payment: CheckoutPaymentView | null = null;
    if (latest && latest.status !== 'FAILED') payment = await this.setupPayment(latest);
    else if (latest) payment = this.toPaymentView(latest);
    return {
      order,
      payment,
      confirmation: order.status === 'CONFIRMED' ? 'CONFIRMED' : 'PENDING_PAYMENT',
    };
  }
  /** External gateway create after commit; unexpected errors keep the retryable order. */
  private async setupPayment(attempt: PaymentIntent): Promise<CheckoutPaymentView> {
    let current = attempt;
    try {
      current = await this.deps.paymentOrders.completeSetup(
        attempt.operationReference,
        attempt.operationReference,
      );
    } catch {
      // The order and durable attempt are committed; the client verifies or
      // retries and the poller reconciles. Never fail the placement response
      // because setup could not complete right now.
    }
    return this.toPaymentView(current);
  }
  private toPaymentView(attempt: PaymentIntent): CheckoutPaymentView {
    const provider = this.env.get('PAYMENTS_PROVIDER') === 'razorpay' ? 'razorpay' : 'fake';
    return {
      attemptId: attempt.attemptId,
      operationReference: attempt.operationReference,
      gatewayOrderId: attempt.gatewayOrderId,
      amountDuePaise: attempt.amountPaise,
      currency: attempt.currency,
      provider,
      publicKeyId: provider === 'razorpay' ? (this.env.get('RAZORPAY_KEY_ID') ?? null) : null,
    };
  }
  /** Wallet application for the quote; disabled wallets quote without wallet. */
  private async walletInput(
    userId: string,
  ): Promise<
    | { promoAvailablePaise: string; cashAvailablePaise: string; promoSpendCapBps: number }
    | undefined
  > {
    const flag = await sql<{ enabled: boolean }>`SELECT enabled FROM feature_flags
      WHERE key='wallet_enabled'`.execute(this.db);
    if (flag.rows[0]?.enabled !== true) return undefined;
    const rows = await sql<{ cash: string; promo: string }>`SELECT
      a.cash_balance_paise::text AS cash,
      COALESCE((SELECT sum(l.remaining_paise) FROM wallet_promo_lots l
        WHERE l.account_id=a.id AND l.state='ACTIVE' AND l.remaining_paise>0
          AND (l.expires_at IS NULL OR l.expires_at>statement_timestamp())),0)::text AS promo
      FROM wallet_accounts a WHERE a.user_id=${userId}::uuid`.execute(this.db);
    const balances = rows.rows[0];
    return {
      promoAvailablePaise: balances?.promo ?? '0',
      cashAvailablePaise: balances?.cash ?? '0',
      promoSpendCapBps: await this.deps.config.get('promoSpendCapBps'),
    };
  }
}
