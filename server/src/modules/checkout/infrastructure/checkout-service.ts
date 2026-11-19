import { sql } from 'kysely';
import {
  IdempotencyStore,
  type IdempotencyOwner,
} from '../../../common/idempotency/idempotency.js';
import { lockActiveCustomer } from '../../identity/contracts/account-lock.js';
import { transactionWithRetry, type Database } from '../../../platform/database/database.js';
import type { ConfigService } from '../../../config/config.service.js';
import type { CartIntents } from '../../cart/contracts/intent.js';
import type { CartView } from '../../cart/contracts/cart.js';
import type { CartQuotes, QuoteSnapshot } from '../../cart/contracts/quote.js';
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
  CheckoutPlacementGuard,
  CheckoutPlacementStatus,
  CheckoutPlaceResult,
  CheckoutQuoteRequest,
  CheckoutQuoteResult,
} from '../contracts/checkout.js';
import { codEligibility } from './cod-eligibility.js';
import { PlaceOrderSaga } from './place-order.js';
import { ScheduledOrderService } from './scheduled-order.js';
import type { ScheduledOrderInput } from '../contracts/checkout.js';
import type { TransactionContext } from '../../../platform/database/database.js';
import type { HttpMetrics } from '../../../platform/metrics/http-metrics.js';

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
    private readonly metrics?: HttpMetrics,
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
    const started = performance.now();
    try {
      return await this.quoteInternal(userId, input);
    } finally {
      this.metrics?.observeStage('checkout_quote', performance.now() - started);
    }
  }
  private async quoteInternal(
    userId: string,
    input: CheckoutQuoteRequest,
  ): Promise<CheckoutQuoteResult> {
    const location = await sql<{ required: boolean; present: boolean }>`SELECT
      COALESCE((SELECT enabled FROM feature_flags WHERE key='customer_location_required'),false) AS required,
      (point IS NOT NULL) AS present FROM addresses
      WHERE id=${input.addressId}::uuid AND user_id=${userId}::uuid AND deleted_at IS NULL`.execute(
      this.db,
    );
    if (!location.rows[0]) throw new Error('ADDRESS_NOT_FOUND');
    if (location.rows[0].required && !location.rows[0].present)
      throw new Error('ADDRESS_LOCATION_REQUIRED');
    const wallet = await this.walletInput(userId);
    // A concurrent quote must not supersede this snapshot between its creation
    // and issuing the unique cart/version intent. The cart view comes from the
    // same evaluation inside the same transaction.
    const txnStarted = performance.now();
    let result: {
      quote: QuoteSnapshot;
      cart: CartView;
      intent: Awaited<ReturnType<CartIntents['issue']>>;
    };
    try {
      result = await transactionWithRetry(this.db, async (tx) => {
        const { quote, cart } = await this.deps.quotes.refreshWithCart({
          userId,
          addressId: input.addressId,
          tipPaise: input.tipPaise,
          couponCode: input.couponCode ?? undefined,
          wallet,
          tx,
        });
        const intent = await this.deps.intents.issue(
          quote.cartId,
          quote.cartVersion,
          quote.quoteId,
          tx,
        );
        return { quote, cart, intent };
      });
    } finally {
      this.metrics?.observeStage('checkout_quote_txn', performance.now() - txnStarted);
    }
    const { quote, cart, intent } = result;
    const codAvailable =
      BigInt(quote.amountDuePaise) === 0n ||
      (await this.canPayCash(userId, quote.storeId, quote.amountDuePaise));
    return {
      quote,
      intentId: intent.intentId,
      intentExpiresAt: intent.expiresAt,
      codAvailable,
      cart,
    };
  }

  async placementStatus(userId: string, key: string): Promise<CheckoutPlacementStatus> {
    if (!key || key.length > 150) throw new Error('INVALID_INPUT');
    // The claim is scoped to this actor and route. A committed order takes
    // precedence over the response lease, which may still be PROCESSING.
    const result = await sql<{
      state: 'PROCESSING' | 'COMPLETED';
      live: boolean | null;
      order_id: string | null;
      order_number: string | null;
      order_status: OrderView['status'] | null;
      payment_status: OrderView['paymentStatus'] | null;
    }>`SELECT i.state, i.lease_until > clock_timestamp() AS live,
      o.id::text AS order_id,o.order_number,o.status AS order_status,o.payment_status
      FROM idempotency_keys i
      LEFT JOIN LATERAL (
        SELECT id,order_number,status,payment_status FROM orders
        WHERE user_id=${userId}::uuid AND metadata->>'checkoutOperationId'=i.operation_id::text
        ORDER BY placed_at,id LIMIT 1
      ) o ON true
      WHERE i.actor=${userId} AND i.audience='customer' AND i.method='POST'
        AND i.resource='/v1/customer/checkout/place' AND i.key=${key}`.execute(this.db);
    const row = result.rows[0];
    if (row?.order_id && row.order_number && row.order_status && row.payment_status)
      return {
        state: 'ORDER_FOUND',
        order: {
          orderId: row.order_id,
          orderNumber: row.order_number,
          status: row.order_status,
          paymentStatus: row.payment_status,
        },
      };
    if (row?.state === 'PROCESSING' && row.live) return { state: 'PROCESSING' };
    // Absence or an expired lease cannot prove the original request failed.
    return { state: 'UNKNOWN' };
  }

  async recoverCommitted(userId: string, operationId: string): Promise<CheckoutPlaceResult | null> {
    const order = await this.saga.findResumable(operationId);
    if (!order || order.userId !== userId) return null;
    const attempts = await this.deps.paymentOrders.listAttempts(order.orderId);
    const latest = attempts[attempts.length - 1];
    // Recovery reads the durable attempt only. It must never call the gateway.
    return {
      order,
      payment: latest ? this.toPaymentView(latest) : null,
      confirmation: this.confirmationFor(order),
    };
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
    guard?: CheckoutPlacementGuard,
  ): Promise<CheckoutPlaceResult> {
    if (
      owner &&
      (owner.operationId !== input.idempotencyOperationId || owner.scope.actor !== userId)
    )
      throw new Error('IDEMPOTENCY_LEASE_LOST');
    const resumable = await this.saga.findResumable(input.idempotencyOperationId);
    if (resumable) return this.resume(userId, resumable);
    const idempotency = owner ? new IdempotencyStore(this.db) : undefined;
    const placementStarted = performance.now();
    const outcome = await transactionWithRetry(this.db, async (tx) => {
      if (owner) await idempotency!.lockOwner(tx, owner);
      await lockActiveCustomer(userId, tx);
      const existing = await this.saga.findResumable(input.idempotencyOperationId, tx);
      if (existing) {
        if (owner) await idempotency!.extendLocked(tx, owner);
        return { existing } as const;
      }
      await guard?.beforePlace(tx);
      const placed = await this.saga.place(userId, input, tx);
      await guard?.afterPlace(tx, { order: placed.order, confirmed: placed.confirmed });
      if (owner) await idempotency!.extendLocked(tx, owner);
      return { placed } as const;
    });
    this.metrics?.observeStage(
      'checkout_placement_transaction',
      performance.now() - placementStarted,
    );
    if (outcome.existing) return this.resume(userId, outcome.existing);
    const placed = outcome.placed;
    const postCommitStarted = performance.now();
    const payment = placed.attempt ? await this.setupPayment(placed.attempt) : null;
    // Checkout velocity now runs as a durable outbox consumer; it must not
    // block the placement response or COD checkout with gateway work.
    this.metrics?.observeStage('checkout_post_commit', performance.now() - postCommitStarted);
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
    if (latest && latest.status !== 'FAILED' && order.status === 'PENDING_PAYMENT')
      payment = await this.setupPayment(latest);
    else if (latest) payment = this.toPaymentView(latest);
    return {
      order,
      payment,
      confirmation: this.confirmationFor(order),
    };
  }
  private confirmationFor(order: OrderView): CheckoutPlaceResult['confirmation'] {
    if (order.status === 'PENDING_PAYMENT') return 'PENDING_PAYMENT';
    if (['PAYMENT_FAILED', 'CANCELLED', 'EXPIRED'].includes(order.status)) return 'ORDER_CLOSED';
    return 'CONFIRMED';
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
    // Eligibility and both balances arrive in one round trip; the spend cap is
    // read only when the wallet is enabled.
    const rows = await sql<{ enabled: boolean | null; cash: string | null; promo: string }>`SELECT
      (SELECT enabled FROM feature_flags WHERE key='wallet_enabled') AS enabled,
      (SELECT a.cash_balance_paise::text FROM wallet_accounts a WHERE a.user_id=${userId}::uuid) AS cash,
      (SELECT COALESCE(sum(l.remaining_paise),0)::text FROM wallet_promo_lots l JOIN wallet_accounts a ON a.id=l.account_id
        WHERE a.user_id=${userId}::uuid AND l.state='ACTIVE' AND l.remaining_paise>0
          AND (l.expires_at IS NULL OR l.expires_at>statement_timestamp())) AS promo`.execute(
      this.db,
    );
    const balances = rows.rows[0];
    if (balances?.enabled !== true) return undefined;
    return {
      promoAvailablePaise: balances.promo,
      cashAvailablePaise: balances.cash ?? '0',
      promoSpendCapBps: await this.deps.config.get('promoSpendCapBps'),
    };
  }
}
