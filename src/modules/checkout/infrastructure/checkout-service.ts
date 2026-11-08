import { sql } from 'kysely';
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
    return { quote, intentId: intent.intentId, intentExpiresAt: intent.expiresAt };
  }
  async place(userId: string, input: CheckoutPlaceRequest): Promise<CheckoutPlaceResult> {
    const resumable = await this.saga.findResumable(input.idempotencyOperationId);
    if (resumable) return this.resume(userId, resumable);
    const placed = await transactionWithRetry(this.db, (tx) => this.saga.place(userId, input, tx));
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
      COALESCE(cash_balance_paise,0)::text AS cash, COALESCE(promo_balance_paise,0)::text AS promo
      FROM wallet_accounts WHERE user_id=${userId}::uuid`.execute(this.db);
    const balances = rows.rows[0];
    return {
      promoAvailablePaise: balances?.promo ?? '0',
      cashAvailablePaise: balances?.cash ?? '0',
      promoSpendCapBps: await this.deps.config.get('promoSpendCapBps'),
    };
  }
}
