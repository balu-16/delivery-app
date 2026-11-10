import { sql } from 'kysely';
import type { TransactionContext } from '../../../platform/database/database.js';
import { fulfillmentAmounts } from '../domain/fulfillment-amounts.js';

export interface FulfillmentSource {
  variant_id: string;
  ordered_qty: string;
  unit_price_paise: string;
  discount_paise: string;
  name_snapshot: string;
  hsn_code: string;
  mrp_paise: string;
  tax_rate_bps: number;
}
export async function priceFulfillment(
  tx: TransactionContext,
  item: FulfillmentSource,
  fulfilled: string,
  storeId: string,
  replacementId?: string,
) {
  let variantId = item.variant_id,
    name = item.name_snapshot,
    hsn = item.hsn_code,
    mrp = item.mrp_paise,
    taxBps = item.tax_rate_bps,
    replacementUnit: bigint | undefined;
  if (replacementId) {
    const found = await sql<{
      name: string;
      hsn: string;
      tax_bps: number;
      selling: string;
      mrp: string;
    }>`SELECT p.name||' — '||v.name AS name,
      COALESCE(p.hsn_code,'') AS hsn,COALESCE(p.gst_rate_bps,0) AS tax_bps,cp.selling_paise::text AS selling,cp.mrp_paise::text AS mrp
      FROM catalog_variants v JOIN catalog_products p ON p.id=v.product_id JOIN catalog_prices cp ON cp.variant_id=v.id
      WHERE v.id=${replacementId}::uuid AND cp.store_id=${storeId}::uuid AND cp.valid_from<=clock_timestamp()
        AND (cp.valid_to IS NULL OR cp.valid_to>clock_timestamp()) AND p.published AND p.deleted_at IS NULL AND v.deleted_at IS NULL
      LIMIT 1 FOR SHARE OF v,p,cp`.execute(tx);
    const row = found.rows[0];
    if (!row) throw new Error('SUBSTITUTION_NOT_PERMITTED');
    variantId = replacementId;
    name = row.name;
    hsn = row.hsn;
    mrp = row.mrp;
    taxBps = row.tax_bps;
    replacementUnit = BigInt(row.selling);
  }
  const amounts = fulfillmentAmounts({
    ordered: BigInt(item.ordered_qty),
    fulfilled: BigInt(fulfilled),
    unit: BigInt(item.unit_price_paise),
    discount: BigInt(item.discount_paise),
    replacementUnit,
    taxBps,
  });
  return {
    reduction: amounts.reduction,
    snapshot: {
      variantId,
      name,
      hsn,
      mrpPaise: mrp,
      quantity: item.ordered_qty,
      fulfilledQty: fulfilled,
      shortQty: (BigInt(item.ordered_qty) - BigInt(fulfilled)).toString(),
      unitPricePaise: amounts.unit.toString(),
      discountPaise: amounts.discount.toString(),
      taxPaise: amounts.tax.toString(),
      taxRateBps: taxBps,
      lineTotalPaise: amounts.net.toString(),
    },
  };
}
