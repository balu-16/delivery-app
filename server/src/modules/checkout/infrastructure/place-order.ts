import { sql } from 'kysely';
import { lockActiveCustomer } from '../../identity/contracts/account-lock.js';
import { uuidV7 } from '../../../common/ids/ids.js';
import { appendEvent } from '../../../platform/outbox/outbox.js';
import {
  databaseTimeAfterLock,
  type Database,
  type TransactionContext,
} from '../../../platform/database/database.js';
import type { Serviceability } from '../../serviceability/contracts/serviceability.js';
import type { CapacityClaims } from '../../serviceability/contracts/serviceability.js';
import type { CartIntents } from '../../cart/contracts/intent.js';
import type { CartQuotes, QuoteSnapshot } from '../../cart/contracts/quote.js';
import type { CouponRedemptions } from '../../coupons/contracts/coupons.js';
import type { InventoryReservations } from '../../inventory/contracts/inventory.js';
import type { WalletFunding, WalletSpender } from '../../wallet/contracts/wallet.js';
import type { PaymentIntent, PaymentOrderOperations } from '../../payments/contracts/payments.js';
import type {
  CreateOrderInput,
  OrderFeeLine,
  OrderOperations,
  OrderView,
} from '../../orders/contracts/orders.js';
import type { AppConfig } from '../../app-config/contracts/config.js';
import { parseMoney } from '../../../common/money/money.js';
import type { CheckoutPlaceRequest } from '../contracts/checkout.js';
import { codEligibility } from './cod-eligibility.js';

export interface PlaceDependencies {
  readonly db: Database;
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

interface AddressContext {
  readonly addressId: string;
  readonly lat: number;
  readonly lng: number;
  readonly zoneId: string | null;
}

/**
 * The placement saga (plan 20.1 / 5.4, D15). ONE transaction consumes the
 * cart intent, revalidates every commercial version, reacquires coupon,
 * wallet and stock obligations, freezes the order with item/fee snapshots
 * and commits history + ORDER_CREATED. Gateway setup runs strictly after the
 * commit (checkout-service.ts).
 *
 * Capacity, wallet, coupon, stock and intent changes join the placement
 * transaction. A placement failure rolls back every obligation.
 */
export class PlaceOrderSaga {
  constructor(private readonly deps: PlaceDependencies) {}
  /** Resumes the order previously placed under the same idempotency operation. */
  async findResumable(operationId: string, tx?: TransactionContext): Promise<OrderView | null> {
    const rows = await sql<{ id: string }>`SELECT id::text AS id FROM orders
      WHERE metadata->>'checkoutOperationId' = ${operationId}
      ORDER BY placed_at LIMIT 1`.execute(tx ?? this.deps.db);
    const id = rows.rows[0]?.id;
    return id ? await this.deps.orders.byId(id, { tx }) : null;
  }
  async place(
    userId: string,
    input: CheckoutPlaceRequest,
    tx: TransactionContext,
  ): Promise<{ order: OrderView; attempt: PaymentIntent | null; confirmed: boolean }> {
    await lockActiveCustomer(userId, tx);
    const quote = await this.deps.quotes.get(input.quoteId, userId, tx);
    if (quote.status !== 'ACTIVE') throw new Error('QUOTE_EXPIRED');
    const now = await databaseTimeAfterLock(tx);
    if (new Date(quote.expiresAt) <= now) throw new Error('QUOTE_EXPIRED');
    if (!quote.lines.length) throw new Error('INVALID_INPUT');

    // 1. Business-level uniqueness (ADR 0009): a second placement with ANY
    // idempotency key fails until a new quote + intent has been issued.
    await this.deps.intents.consume(
      input.intentId,
      { cartId: quote.cartId, cartVersion: quote.cartVersion, quoteId: input.quoteId },
      tx,
    );
    await this.deps.quotes.markConsumed(input.quoteId, tx);

    // 2. Re-check the world: the bound store is still serviceable for this
    // address right now (zone, store open, paused/capacity reasons).
    const address = await this.addressContext(tx, quote.addressId, userId);
    const check = await this.deps.serviceability.check(
      {
        lat: address.lat,
        lng: address.lng,
        targetTime: now,
      },
      tx,
    );
    if (!check.serviceable || check.storeId !== quote.storeId)
      throw new Error('ADDRESS_NOT_SERVICEABLE');

    const orderId = uuidV7();
    const windowSeconds = await this.deps.config.get('paymentWindowSeconds', tx);
    // 7. Capacity claim joins this transaction.
    const claimed = await this.deps.capacity.claim(quote.storeId, now, orderId, tx);
    if (claimed === 'AT_CAPACITY') throw new Error('ADDRESS_NOT_SERVICEABLE');
    // Capacity holds the store row lock. Revalidate the mutable routing state
    // after acquiring it, then keep the selected zone stable until commit.
    const store = await sql<{
      status: string;
    }>`SELECT status FROM stores WHERE id=${quote.storeId}::uuid`.execute(tx);
    if (store.rows[0]?.status !== 'ONLINE' || !check.zone)
      throw new Error('ADDRESS_NOT_SERVICEABLE');
    const zone = await sql`SELECT id FROM zones WHERE id=${check.zone.zoneId}::uuid
      AND store_id=${quote.storeId}::uuid AND active AND version=${check.zone.zoneVersion}::bigint
      AND ST_Covers(polygon,ST_SetSRID(ST_MakePoint(${address.lng},${address.lat}),4326)) FOR SHARE`.execute(
      tx,
    );
    if (!zone.rows.length) throw new Error('ADDRESS_NOT_SERVICEABLE');
    // 3. Coupon quota (global + per-user) under its own locks.
    const couponReservationId = quote.couponCode
      ? await this.deps.coupons.reserve(quote.couponCode, userId, tx)
      : null;
    // 4. Wallet debit (promo-first cap, then cash) under the account lock;
    // ledger uniqueness on the ORDER reference rejects a repeated debit.
    const walletSplit = await this.debitWallet(tx, userId, orderId, quote);
    // 5. Freeze the order: item snapshots, fee breakdown, payment window.
    const catalog = await this.catalogSnapshots(
      tx,
      quote.lines.map((line) => line.variantId),
    );
    const fees: OrderFeeLine[] = quote.fees.map((fee) => ({ ...fee }));
    const create: CreateOrderInput = {
      orderId,
      userId,
      storeId: quote.storeId,
      addressSnapshot: {
        addressId: address.addressId,
        zoneId: check.zone?.zoneId ?? address.zoneId,
        zoneVersion: check.zone.zoneVersion,
        cityZoneVersion: check.zone.cityZoneVersion,
        deliveryFeePaise: quote.fees.find((fee) => fee.kind === 'DELIVERY')?.amountPaise ?? '0',
        line1: address.line1,
        line2: address.line2,
        landmark: address.landmark,
        pincode: address.pincode,
        contactName: address.contactName,
        contactPhone: address.contactPhone,
        lat: address.lat,
        lng: address.lng,
      },
      items: quote.lines.map((line) => {
        const snapshot = catalog.get(line.variantId);
        if (!snapshot) throw new Error('ITEM_UNAVAILABLE');
        return {
          variantId: line.variantId,
          nameSnapshot: snapshot.name,
          hsnCode: snapshot.hsn,
          orderedQty: line.quantity,
          unitPricePaise: line.unitPricePaise,
          mrpPaise: line.mrpPaise,
          discountPaise: line.discountPaise,
          taxPaise: line.taxPaise,
          taxRateBps: line.taxRateBps,
        };
      }),
      fees,
      subtotalPaise: quote.subtotalPaise,
      discountPaise: quote.discountPaise,
      feeTotalPaise: quote.feeTotalPaise,
      taxTotalPaise: quote.taxTotalPaise,
      tipPaise: quote.tipPaise,
      totalPaise: quote.totalPaise,
      walletPromoPaise: walletSplit.promoPaise,
      walletCashPaise: walletSplit.cashPaise,
      amountDuePaise: quote.amountDuePaise,
      deliverySlot: null,
      metadata: {
        fees: fees as unknown as Record<string, unknown>[],
        quoteId: quote.quoteId,
        intentId: input.intentId,
        checkoutOperationId: input.idempotencyOperationId,
        couponReservationId,
        couponCode: quote.couponCode,
        couponFingerprint: quote.couponFingerprint,
        referralClaimId: quote.referralClaimId,
        priceVersion: quote.priceVersion,
        configVersion: quote.configVersion,
      },
      expiresAt: new Date(now.getTime() + windowSeconds * 1000).toISOString(),
      tx,
    };
    await this.deps.orders.create(create);
    if (quote.referralClaimId) {
      const redeemed = await sql`UPDATE referral_claims SET redeemed_order_id=${orderId}::uuid
        WHERE id=${quote.referralClaimId}::uuid AND friend_id=${userId}::uuid AND redeemed_order_id IS NULL RETURNING id`.execute(
        tx,
      );
      if (!redeemed.rows.length) throw new Error('PRICE_CHANGED');
    }
    // 6. Refundable-capacity record for the wallet share (FK needs the order).
    if (parseMoney(walletSplit.promoPaise) + parseMoney(walletSplit.cashPaise) > 0n)
      await this.deps.funding.record({
        orderId,
        walletSpendReference: orderId,
        promoPaise: walletSplit.promoPaise,
        cashPaise: walletSplit.cashPaise,
        tx,
      });
    // 8. Stock reservation: HELD with the payment window as its TTL.
    await this.deps.inventory.reserve(
      {
        orderId,
        lines: quote.lines.map((line) => ({
          storeId: line.storeId,
          variantId: line.variantId,
          quantity: line.quantity,
        })),
        targetDeliveryAt: now.toISOString(),
        ttlSeconds: windowSeconds,
      },
      tx,
    );
    // 9. Confirmation decision: zero due confirms without any gateway call;
    // COD confirms when the policy allows; otherwise a durable gateway
    // attempt is created inside this transaction (external call after commit).
    let attempt: PaymentIntent | null = null;
    let confirmed = false;
    if (parseMoney(quote.amountDuePaise) === 0n) {
      await this.deps.orders.confirm(orderId, { kind: 'ZERO_DUE' }, tx);
      confirmed = true;
    } else if (input.method === 'COD') {
      const verdict = await this.codVerdict(tx, userId, quote);
      if (!verdict.allowed) throw new Error(verdict.code);
      await this.deps.orders.confirm(orderId, { kind: 'COD' }, tx);
      confirmed = true;
    } else {
      await sql`UPDATE orders SET payment_method='GATEWAY' WHERE id=${orderId}::uuid`.execute(tx);
      attempt = await this.deps.paymentOrders.createAttempt({
        aggregateId: orderId,
        kind: 'ORDER_PAYMENT',
        amountPaise: quote.amountDuePaise,
        currency: 'INR',
        userId,
        tx,
      });
    }
    await appendEvent(
      tx,
      {
        eventId: uuidV7(),
        eventType: 'ORDER_CREATED',
        schemaVersion: 1,
        aggregateType: 'order',
        aggregateId: orderId,
        aggregateVersion: '1',
        occurredAt: now.toISOString(),
        correlationId: orderId,
        causationId: null,
        payload: {
          orderId,
          userId,
          storeId: quote.storeId,
          totalPaise: quote.totalPaise,
          amountDuePaise: quote.amountDuePaise,
        },
      },
      ['notifications'],
    );
    const order = await this.deps.orders.byId(orderId, { tx });
    if (!order) throw new Error('ORDER_NOT_FOUND');
    return { order, attempt, confirmed };
  }
  private async debitWallet(
    tx: TransactionContext,
    userId: string,
    orderId: string,
    quote: QuoteSnapshot,
  ): Promise<{ promoPaise: string; cashPaise: string }> {
    if (!quote.wallet) return { promoPaise: '0', cashPaise: '0' };
    const total = parseMoney(quote.wallet.promoPaise) + parseMoney(quote.wallet.cashPaise);
    if (total === 0n) return { promoPaise: '0', cashPaise: '0' };
    const split = await this.deps.wallet.spend(userId, orderId, total.toString(), tx, {
      promoCapBasePaise: quote.totalPaise,
    });
    if (split.promoPaise !== quote.wallet.promoPaise || split.cashPaise !== quote.wallet.cashPaise)
      throw new Error('RESOURCE_CONFLICT'); // wallet rules no longer match the frozen quote
    return split;
  }
  private async codVerdict(
    tx: TransactionContext,
    userId: string,
    quote: QuoteSnapshot,
  ): Promise<{ allowed: true } | { allowed: false; code: string }> {
    return codEligibility(
      this.deps.db,
      this.deps.config,
      userId,
      quote.storeId,
      quote.amountDuePaise,
      tx,
    );
  }
  private async addressContext(
    tx: TransactionContext,
    addressId: string,
    userId: string,
  ): Promise<
    AddressContext & {
      line1: string;
      line2: string | null;
      landmark: string | null;
      pincode: string;
      contactName: string;
      contactPhone: string;
    }
  > {
    const rows = await sql<{
      id: string;
      lat: string;
      lng: string;
      zone_id: string | null;
      line1: string;
      line2: string | null;
      landmark: string | null;
      pincode: string;
      contact_name: string;
      contact_phone: string;
    }>`SELECT a.id::text AS id,
        ST_Y(a.point::geometry)::text AS lat, ST_X(a.point::geometry)::text AS lng,
        a.line1,a.line2,a.landmark,a.pincode,a.contact_name,a.contact_phone,
        (SELECT z.id::text FROM zones z WHERE z.active AND ST_Covers(z.polygon, a.point)
         ORDER BY z.priority DESC LIMIT 1) AS zone_id
      FROM addresses a WHERE a.id=${addressId}::uuid AND a.user_id=${userId}::uuid AND a.deleted_at IS NULL FOR SHARE OF a`.execute(
      tx,
    );
    const row = rows.rows[0];
    if (!row) throw new Error('RESOURCE_NOT_FOUND');
    return {
      addressId: row.id,
      lat: Number(row.lat),
      lng: Number(row.lng),
      zoneId: row.zone_id,
      line1: row.line1,
      line2: row.line2,
      landmark: row.landmark,
      pincode: row.pincode,
      contactName: row.contact_name,
      contactPhone: row.contact_phone,
    };
  }
  private async catalogSnapshots(
    tx: TransactionContext,
    variantIds: readonly string[],
  ): Promise<Map<string, { name: string; hsn: string }>> {
    if (!variantIds.length) return new Map();
    const rows = await sql<{ id: string; name: string; hsn: string }>`SELECT v.id::text AS id,
      v.name, p.hsn_code AS hsn
      FROM catalog_variants v JOIN catalog_products p ON p.id = v.product_id
      WHERE v.id = ANY(${variantIds}::uuid[])`.execute(tx);
    return new Map(rows.rows.map((row) => [row.id, { name: row.name, hsn: row.hsn }]));
  }
}
