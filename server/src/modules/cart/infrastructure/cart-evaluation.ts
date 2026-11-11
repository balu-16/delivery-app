import { sql } from 'kysely';
import { createHash } from 'node:crypto';
import type { Database, TransactionContext } from '../../../platform/database/database.js';
import type { AppConfig } from '../../app-config/contracts/config.js';
import type { PricingFeeConfig } from '../../pricing/contracts/pricing.js';
import type { QuoteIssue } from '../contracts/quote.js';
import { evaluateLines } from '../domain/cart.js';

export interface CartRow {
  id: string;
  user_id: string;
  store_id: string;
  address_id: string;
  coupon_code: string | null;
  version: string;
}
export interface EvaluatedLine {
  variantId: string;
  productId: string;
  productName: string;
  variantName: string;
  imageId: string | null;
  categoryId: string | null;
  quantity: bigint;
  storedUnitPricePaise: bigint;
  freshUnitPricePaise: bigint | null;
  mrpPaise: bigint;
  taxRateBps: number;
  available: bigint;
  saleable: boolean;
}
export interface EvaluatedCart {
  cart: CartRow;
  lines: EvaluatedLine[];
  issues: QuoteIssue[];
  subtotalPaise: bigint;
  priceVersion: string;
  priceFingerprint: string;
  configVersion: string;
  fees: PricingFeeConfig;
  minOrderPaise: bigint;
  maxOrderPaise: bigint;
}
interface LineRow {
  variant_id: string;
  quantity: string;
  unit_price_paise: string;
  mrp_paise: string;
  product_id: string;
  product_name: string;
  variant_name: string;
  image_id: string | null;
  category_id: string | null;
  gst_rate_bps: number | null;
  published: boolean;
  product_deleted: Date | null;
  variant_deleted: Date | null;
  fresh_price: string | null;
  fresh_mrp: string | null;
  price_id: string | null;
  available: string;
}
/** Same zone-based store resolution the customer catalog uses; customer-supplied stores never authorize cart reads. */
export async function resolveStoreForAddress(
  db: Database | TransactionContext,
  userId: string,
  addressId: string,
): Promise<string> {
  const selected = await sql<{
    store_id: string;
  }>`SELECT z.store_id::text AS store_id FROM addresses a JOIN LATERAL (
    SELECT z.store_id FROM zones z JOIN stores s ON s.id=z.store_id WHERE z.active AND ST_Covers(z.polygon,a.point::geometry)
    ORDER BY z.priority DESC,ST_Distance(s.location,a.point),s.id,z.id LIMIT 1
  ) z ON true WHERE a.user_id=${userId}::uuid AND a.id=${addressId}::uuid AND a.deleted_at IS NULL`.execute(
    db,
  );
  if (selected.rows[0]) return selected.rows[0].store_id;
  const owned =
    await sql`SELECT 1 AS one FROM addresses WHERE id=${addressId}::uuid AND user_id=${userId}::uuid AND deleted_at IS NULL`.execute(
      db,
    );
  throw new Error(owned.rows.length ? 'ADDRESS_NOT_SERVICEABLE' : 'ADDRESS_NOT_FOUND');
}
export function mapLine(row: LineRow): EvaluatedLine {
  const saleable =
    row.published &&
    row.product_deleted === null &&
    row.variant_deleted === null &&
    row.fresh_price !== null &&
    BigInt(row.available) > 0n;
  return {
    variantId: row.variant_id,
    productId: row.product_id,
    productName: row.product_name,
    variantName: row.variant_name,
    imageId: row.image_id,
    categoryId: row.category_id,
    quantity: BigInt(row.quantity),
    storedUnitPricePaise: BigInt(row.unit_price_paise),
    freshUnitPricePaise: row.fresh_price === null ? null : BigInt(row.fresh_price),
    mrpPaise: BigInt(row.fresh_mrp ?? row.mrp_paise),
    taxRateBps: row.gst_rate_bps ?? 0,
    available: BigInt(row.available),
    saleable,
  };
}
const lineQuery = (cartId: string, storeId: string) =>
  sql<LineRow>`SELECT ci.variant_id::text AS variant_id,ci.quantity::text AS quantity,
  ci.unit_price_paise::text AS unit_price_paise,ci.mrp_paise::text AS mrp_paise,p.id::text AS product_id,
  p.name AS product_name,v.name AS variant_name,
  (SELECT m.id::text FROM catalog_product_images im JOIN catalog_media m ON m.id=im.media_id
    WHERE im.product_id=p.id AND m.state='REGISTERED' AND m.purpose='PRODUCT_IMAGE'
    ORDER BY im.position,m.id LIMIT 1) AS image_id,
  p.category_id::text AS category_id,p.gst_rate_bps,p.published,p.deleted_at AS product_deleted,
  v.deleted_at AS variant_deleted,price.id::text AS price_id,price.selling_paise::text AS fresh_price,price.mrp_paise::text AS fresh_mrp,COALESCE(a.available,0)::text AS available
  FROM cart_items ci
  JOIN catalog_variants v ON v.id=ci.variant_id
  JOIN catalog_products p ON p.id=v.product_id
  LEFT JOIN inventory_saleable_availability a ON a.store_id=${storeId}::uuid AND a.variant_id=ci.variant_id
  LEFT JOIN LATERAL (SELECT id,selling_paise,mrp_paise FROM catalog_prices cp WHERE cp.store_id=${storeId}::uuid
    AND cp.variant_id=ci.variant_id AND cp.valid_from<=statement_timestamp()
    AND (cp.valid_to IS NULL OR cp.valid_to>statement_timestamp()) LIMIT 1) price ON true
  WHERE ci.cart_id=${cartId}::uuid ORDER BY ci.variant_id`;
/** Fresh prices, availability, config and revisions for a cart; pure reads. */
export async function evaluateCart(
  db: Database | TransactionContext,
  config: AppConfig,
  cart: CartRow,
): Promise<EvaluatedCart> {
  const tx = db.isTransaction ? (db as TransactionContext) : undefined;
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
  const settings = config.getMany
    ? config.getMany(keys, tx)
    : Promise.all(keys.map(async (key) => [key, await config.get(key, tx)] as const)).then(
        (entries) =>
          Object.fromEntries(entries) as {
            [K in (typeof keys)[number]]: Awaited<ReturnType<typeof config.get<K>>>;
          },
      );
  const [lines, revision, configVersion, surgeEnabled, values] = await Promise.all([
    lineQuery(cart.id, cart.store_id).execute(db),
    sql<{ revision: string }>`SELECT revision::text FROM catalog_revision WHERE singleton`.execute(
      db,
    ),
    sql<{ version: string }>`SELECT (COALESCE((SELECT sum(version) FROM app_config),0) +
      COALESCE((SELECT sum(version) FROM feature_flags),0))::text AS version`.execute(db),
    sql<{ enabled: boolean }>`SELECT enabled FROM feature_flags WHERE key='surge_enabled'`.execute(
      db,
    ),
    settings,
  ]);
  const {
    deliveryFeeSlabs: feeSlabs,
    freeDeliveryThresholdPaise: freeDeliveryThreshold,
    handlingFeePaise: handlingFee,
    smallCartThresholdPaise: smallCartThreshold,
    smallCartFeePaise: smallCartFee,
    surgeFeePaise: surgeFee,
    feeTaxRules,
    minOrderPaise: minOrder,
    maxOrderPaise: maxOrder,
  } = values;
  const evaluated = lines.rows.map(mapLine);
  const revisionRow = revision.rows[0];
  if (!revisionRow) throw new Error('CATALOG_REVISION_MISSING');
  return {
    cart,
    lines: evaluated,
    issues: evaluateLines(
      evaluated.map((line) => ({
        variantId: line.variantId,
        storedQuantity: line.quantity,
        storedUnitPricePaise: line.storedUnitPricePaise,
        currentUnitPricePaise: line.freshUnitPricePaise,
        available: line.available,
        saleable: line.saleable,
      })),
    ),
    subtotalPaise: evaluated
      .filter((line) => line.saleable)
      .reduce((sum, line) => sum + line.freshUnitPricePaise! * line.quantity, 0n),
    priceVersion: revisionRow.revision,
    // Deliberately exclude stock: reservation changes must not invalidate another quote.
    priceFingerprint: createHash('sha256')
      .update(
        JSON.stringify(
          lines.rows.map((row) => [
            row.variant_id,
            row.product_id,
            row.category_id,
            row.price_id,
            row.fresh_price,
            row.fresh_mrp,
            row.gst_rate_bps,
            row.published,
            row.product_deleted,
            row.variant_deleted,
          ]),
        ),
      )
      .digest('hex'),
    configVersion: configVersion.rows[0]?.version ?? '0',
    fees: {
      deliveryFeeSlabs: feeSlabs.map((slab) => ({
        maxOrderValuePaise:
          slab.maxOrderValuePaise === null ? null : BigInt(slab.maxOrderValuePaise),
        feePaise: BigInt(slab.feePaise),
      })),
      freeDeliveryThresholdPaise: BigInt(freeDeliveryThreshold),
      handlingFeePaise: BigInt(handlingFee),
      smallCartThresholdPaise: BigInt(smallCartThreshold),
      smallCartFeePaise: BigInt(smallCartFee),
      surgeFeePaise: BigInt(surgeFee),
      surgeEnabled: surgeEnabled.rows[0]?.enabled ?? false,
      feeTaxRules,
    },
    minOrderPaise: BigInt(minOrder),
    maxOrderPaise: BigInt(maxOrder),
  };
}
