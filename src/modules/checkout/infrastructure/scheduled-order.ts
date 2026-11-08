import { sql } from 'kysely';
import { uuidV7 } from '../../../common/ids/ids.js';
import { computeQuote } from '../../pricing/contracts/pricing.js';
import { appendEvent } from '../../../platform/outbox/outbox.js';
import type { TransactionContext } from '../../../platform/database/database.js';
import type { CheckoutDependencies } from './checkout-service.js';

import type { ScheduledOrderInput } from '../contracts/checkout.js';

/** Real scheduled checkout uses the same pricing, capacity, wallet, stock and order contracts as customer checkout. */
export class ScheduledOrderService {
  constructor(private readonly deps: CheckoutDependencies) {}
  private async prepare(input: ScheduledOrderInput, tx: TransactionContext) {
    if (!/^[1-9]\d{0,18}$/.test(input.quantity)) throw new Error('INVALID_QUANTITY');
    const flags = await sql<{
      key: string;
      enabled: boolean;
    }>`SELECT key,enabled FROM feature_flags WHERE key IN ('wallet_enabled','subscriptions_enabled')`.execute(
      tx,
    );
    if (
      !['wallet_enabled', 'subscriptions_enabled'].every((key) =>
        flags.rows.some((row) => row.key === key && row.enabled),
      )
    )
      throw new Error('SUBSCRIPTIONS_DISABLED');
    const start = new Date(input.slotStart);
    if (!Number.isFinite(start.getTime()) || new Date(input.slotEnd) <= start)
      throw new Error('INVALID_SLOT');
    const address = await sql<{
      line1: string;
      line2: string | null;
      landmark: string | null;
      pincode: string;
      contact_name: string;
      contact_phone: string;
      lat: string;
      lng: string;
    }>`SELECT line1,line2,landmark,pincode,contact_name,contact_phone,ST_Y(point::geometry)::text AS lat,ST_X(point::geometry)::text AS lng FROM addresses WHERE id=${input.addressId}::uuid AND user_id=${input.userId}::uuid AND deleted_at IS NULL FOR SHARE`.execute(
      tx,
    );
    const a = address.rows[0];
    if (!a) throw new Error('ADDRESS_NOT_SERVICEABLE');
    const service = await this.deps.serviceability.check(
      { lat: Number(a.lat), lng: Number(a.lng), targetTime: start },
      tx,
    );
    if (service.reasons.includes('STORE_CLOSED')) throw new Error('STORE_CLOSED');
    if (service.reasons.includes('STORE_AT_CAPACITY')) throw new Error('STORE_AT_CAPACITY');
    if (
      service.reasons.some((reason) => reason !== 'NO_RIDERS_AVAILABLE') ||
      service.storeId !== input.storeId ||
      !service.zone
    )
      throw new Error('ADDRESS_NOT_SERVICEABLE');
    const product = await sql<{
      name: string;
      hsn: string;
      tax: number;
      selling: string;
      mrp: string;
    }>`SELECT v.name,p.hsn_code AS hsn,COALESCE(p.gst_rate_bps,0) AS tax, cp.selling_paise::text AS selling,cp.mrp_paise::text AS mrp FROM catalog_variants v JOIN catalog_products p ON p.id=v.product_id JOIN catalog_prices cp ON cp.variant_id=v.id AND cp.store_id=${input.storeId}::uuid AND cp.valid_from<=statement_timestamp() AND (cp.valid_to IS NULL OR cp.valid_to>statement_timestamp()) WHERE v.id=${input.variantId}::uuid AND v.deleted_at IS NULL AND p.deleted_at IS NULL AND p.published FOR SHARE OF v,p,cp`.execute(
      tx,
    );
    const p = product.rows[0];
    if (!p) throw new Error('ITEM_UNAVAILABLE');
    const c = this.deps.config;
    const keys = [
      'deliveryFeeSlabs',
      'freeDeliveryThresholdPaise',
      'handlingFeePaise',
      'smallCartThresholdPaise',
      'smallCartFeePaise',
      'surgeFeePaise',
      'feeTaxRules',
      'minOrderPaise',
      'maxOrderPaise',
    ] as const;
    const pricing = c.getMany
      ? await c.getMany(keys, tx)
      : (Object.fromEntries(
          await Promise.all(keys.map(async (key) => [key, await c.get(key, tx)])),
        ) as {
          [K in (typeof keys)[number]]: Awaited<ReturnType<typeof c.get<K>>>;
        });
    const {
      deliveryFeeSlabs: slabs,
      freeDeliveryThresholdPaise: free,
      handlingFeePaise: handling,
      smallCartThresholdPaise: smallThreshold,
      smallCartFeePaise: smallFee,
      surgeFeePaise: surge,
      feeTaxRules: taxRules,
      minOrderPaise: min,
      maxOrderPaise: max,
    } = pricing;
    const surgeFlag = await sql<{
      enabled: boolean;
    }>`SELECT enabled FROM feature_flags WHERE key='surge_enabled'`.execute(tx);
    const quote = computeQuote({
      lines: [
        {
          variantId: input.variantId,
          quantity: BigInt(input.quantity),
          unitPricePaise: BigInt(p.selling),
          mrpPaise: BigInt(p.mrp),
          taxRateBps: p.tax,
          eligibleForDiscount: false,
        },
      ],
      coupon: null,
      tipPaise: 0n,
      wallet: null,
      minOrderPaise: BigInt(min),
      maxOrderPaise: BigInt(max),
      fees: {
        deliveryFeeSlabs: slabs.map((s) => ({
          maxOrderValuePaise: s.maxOrderValuePaise === null ? null : BigInt(s.maxOrderValuePaise),
          feePaise: BigInt(s.feePaise),
        })),
        freeDeliveryThresholdPaise: BigInt(free),
        handlingFeePaise: BigInt(handling),
        smallCartThresholdPaise: BigInt(smallThreshold),
        smallCartFeePaise: BigInt(smallFee),
        surgeFeePaise: BigInt(surge),
        surgeEnabled: surgeFlag.rows[0]?.enabled ?? false,
        feeTaxRules: taxRules,
      },
    });
    if (quote.minOrderNotMet) throw new Error('MIN_ORDER_NOT_MET');
    if (quote.maxOrderExceeded) throw new Error('MAX_ORDER_EXCEEDED');
    return { quote, product: p, address: a, service, start, config: c };
  }
  async price(input: ScheduledOrderInput, tx: TransactionContext) {
    const { quote, product } = await this.prepare(input, tx);
    return { unitPricePaise: product.selling, totalPaise: quote.totalPaise.toString() };
  }
  async place(input: ScheduledOrderInput, tx: TransactionContext) {
    const {
      quote,
      product: p,
      address: a,
      service,
      start,
      config: c,
    } = await this.prepare(input, tx);
    if (!service.zone) throw new Error('ADDRESS_NOT_SERVICEABLE');
    const id = uuidV7();
    if ((await this.deps.capacity.claim(input.storeId, start, id, tx)) === 'AT_CAPACITY')
      throw new Error('STORE_AT_CAPACITY');
    const route =
      await sql`SELECT 1 FROM stores s JOIN zones z ON z.store_id=s.id WHERE s.id=${input.storeId}::uuid AND s.status='ONLINE' AND z.id=${service.zone.zoneId}::uuid AND z.active AND z.version=${service.zone.zoneVersion}::bigint AND ST_Covers(z.polygon,ST_SetSRID(ST_MakePoint(${Number(a.lng)},${Number(a.lat)}),4326)) FOR SHARE OF z`.execute(
        tx,
      );
    if (!route.rows.length) throw new Error('ADDRESS_NOT_SERVICEABLE');
    const split =
      quote.totalPaise > 0n
        ? await this.deps.wallet.spend(input.userId, id, quote.totalPaise.toString(), tx, {
            promoCapBasePaise: quote.totalPaise.toString(),
          })
        : { promoPaise: '0', cashPaise: '0' };
    const line = quote.lines[0]!;
    await this.deps.orders.create({
      orderId: id,
      userId: input.userId,
      storeId: input.storeId,
      source: 'SUBSCRIPTION',
      addressSnapshot: {
        addressId: input.addressId,
        zoneId: service.zone.zoneId,
        line1: a.line1,
        line2: a.line2,
        landmark: a.landmark,
        pincode: a.pincode,
        contactName: a.contact_name,
        contactPhone: a.contact_phone,
        lat: Number(a.lat),
        lng: Number(a.lng),
      },
      items: [
        {
          variantId: input.variantId,
          nameSnapshot: p.name,
          hsnCode: p.hsn,
          orderedQty: input.quantity,
          unitPricePaise: p.selling,
          mrpPaise: p.mrp,
          discountPaise: line.discountPaise.toString(),
          taxPaise: line.taxPaise.toString(),
          taxRateBps: p.tax,
        },
      ],
      fees: quote.fees.map((f) => ({
        kind: f.kind,
        amountPaise: f.amountPaise.toString(),
        taxPaise: f.taxPaise.toString(),
        taxSplit: f.taxSplit,
      })),
      subtotalPaise: quote.subtotalPaise.toString(),
      discountPaise: quote.discountPaise.toString(),
      feeTotalPaise: quote.feeTotalPaise.toString(),
      taxTotalPaise: quote.taxTotalPaise.toString(),
      tipPaise: '0',
      totalPaise: quote.totalPaise.toString(),
      walletPromoPaise: split.promoPaise,
      walletCashPaise: split.cashPaise,
      amountDuePaise: '0',
      deliverySlot: { slotStart: input.slotStart, slotEnd: input.slotEnd },
      metadata: { subscriptionId: input.subscriptionId, deliveryDate: input.deliveryDate },
      expiresAt: null,
      tx,
    });
    if (quote.totalPaise > 0n)
      await this.deps.funding.record({
        orderId: id,
        walletSpendReference: id,
        promoPaise: split.promoPaise,
        cashPaise: split.cashPaise,
        tx,
      });
    await this.deps.inventory.reserve(
      {
        orderId: id,
        lines: [{ storeId: input.storeId, variantId: input.variantId, quantity: input.quantity }],
        targetDeliveryAt: input.slotStart,
        ttlSeconds: await c.get('paymentWindowSeconds', tx),
      },
      tx,
    );
    await this.deps.orders.confirm(id, { kind: quote.totalPaise > 0n ? 'WALLET' : 'ZERO_DUE' }, tx);
    await appendEvent(
      tx,
      {
        eventId: uuidV7(),
        eventType: 'ORDER_CREATED',
        schemaVersion: 1,
        aggregateType: 'order',
        aggregateId: id,
        aggregateVersion: '1',
        occurredAt: new Date().toISOString(),
        correlationId: id,
        causationId: null,
        payload: {
          orderId: id,
          userId: input.userId,
          storeId: input.storeId,
          totalPaise: quote.totalPaise.toString(),
          amountDuePaise: '0',
        },
      },
      ['notifications'],
    );
    return { orderId: id, unitPricePaise: p.selling, totalPaise: quote.totalPaise.toString() };
  }
}
