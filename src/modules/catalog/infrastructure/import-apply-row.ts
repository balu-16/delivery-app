import { sql } from 'kysely';
import { uuidV7 } from '../../../common/ids/ids.js';
import type { TransactionContext } from '../../../platform/database/database.js';
import type { AppConfig } from '../../app-config/contracts/config.js';
import type { ImportRow } from '../domain/import.js';
import { normalizeName } from '../domain/catalog.js';
export async function applyImportRow(
  tx: TransactionContext,
  job: { owner_id: string; options: { storeId: string } },
  row: ImportRow,
  approved: boolean,
  config: AppConfig,
): Promise<void> {
  // Serialize first-time SKU creation and existing variant updates across workers.
  await sql`SELECT pg_advisory_xact_lock(hashtextextended(${row.sku},0))`.execute(tx);
  const existing = await sql<{
    id: string;
    product_id: string;
    published: boolean;
    deleted_at: Date | null;
    product_deleted_at: Date | null;
  }>`SELECT v.id,v.product_id,p.published,v.deleted_at,p.deleted_at AS product_deleted_at FROM catalog_variants v JOIN catalog_products p ON p.id=v.product_id WHERE v.sku=${row.sku} FOR UPDATE OF p,v`.execute(
    tx,
  );
  if (existing.rows[0]?.deleted_at || existing.rows[0]?.product_deleted_at)
    throw new Error('RESOURCE_NOT_FOUND');
  const category =
    await sql`SELECT id FROM catalog_categories WHERE id=${row.categoryId}::uuid AND deleted_at IS NULL FOR SHARE`.execute(
      tx,
    );
  if (!category.rows.length) throw new Error('RESOURCE_NOT_FOUND');
  if (!(await config.get('catalogAllowedGstBps')).includes(row.gstRateBps))
    throw new Error('INVALID_GST');
  const product = existing.rows[0]?.product_id ?? uuidV7(),
    variant = existing.rows[0]?.id ?? uuidV7();
  await sql`INSERT INTO catalog_products(id,category_id,name,normalized_name,description,hsn_code,gst_rate_bps,perishable,expiry_tracking) VALUES(${product}::uuid,${row.categoryId}::uuid,${row.productName},${normalizeName(row.productName)},'',${row.hsnCode},${row.gstRateBps},${row.perishable},${row.expiryTracking}) ON CONFLICT(id) DO UPDATE SET category_id=EXCLUDED.category_id,name=EXCLUDED.name,normalized_name=EXCLUDED.normalized_name,hsn_code=EXCLUDED.hsn_code,gst_rate_bps=EXCLUDED.gst_rate_bps,perishable=EXCLUDED.perishable,expiry_tracking=EXCLUDED.expiry_tracking,updated_at=clock_timestamp()`.execute(
    tx,
  );
  if (existing.rows[0]?.published) {
    const valid = await sql<{
      ok: boolean;
    }>`SELECT EXISTS(SELECT 1 FROM catalog_product_images im JOIN catalog_media m ON m.id=im.media_id WHERE im.product_id=${product}::uuid AND m.purpose='PRODUCT_IMAGE' AND m.state='REGISTERED') AND (p.brand_id IS NULL OR EXISTS(SELECT 1 FROM catalog_brands b WHERE b.id=p.brand_id AND b.deleted_at IS NULL)) AS ok FROM catalog_products p WHERE p.id=${product}::uuid`.execute(
      tx,
    );
    if (!valid.rows[0]?.ok) throw new Error('PRODUCT_NOT_PUBLISHABLE');
  }
  await sql`INSERT INTO catalog_variants(id,product_id,name,sku,barcode) VALUES(${variant}::uuid,${product}::uuid,${row.variantName},${row.sku},${row.barcode}) ON CONFLICT(id) DO UPDATE SET name=EXCLUDED.name,barcode=EXCLUDED.barcode,updated_at=clock_timestamp()`.execute(
    tx,
  );
  await sql`INSERT INTO store_inventory(store_id,variant_id) VALUES(${job.options.storeId}::uuid,${variant}::uuid) ON CONFLICT DO NOTHING`.execute(
    tx,
  );
  await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${job.options.storeId}:${variant}`},0))`.execute(
    tx,
  );
  const time = await sql<{ now: Date }>`SELECT clock_timestamp() AS now`.execute(tx),
    now = time.rows[0]!.now;
  const current = await sql<{
    selling_paise: string;
  }>`SELECT selling_paise::text FROM catalog_prices WHERE store_id=${job.options.storeId}::uuid AND variant_id=${variant}::uuid AND valid_from<=${now} AND (valid_to IS NULL OR valid_to>${now})`.execute(
    tx,
  );
  if (!approved && current.rows[0]) {
    const before = BigInt(current.rows[0].selling_paise),
      after = BigInt(row.sellingPaise),
      threshold = BigInt(await config.get('catalogPriceApprovalPercent'));
    if (
      before === 0n
        ? after > 0n
        : (after > before ? after - before : before - after) * 100n > before * threshold
    )
      throw new Error('APPROVAL_REQUIRED');
  }
  await sql`UPDATE catalog_prices SET valid_to=${now} WHERE store_id=${job.options.storeId}::uuid AND variant_id=${variant}::uuid AND valid_from<${now} AND (valid_to IS NULL OR valid_to>${now})`.execute(
    tx,
  );
  const next = await sql<{
    valid_from: Date;
  }>`SELECT valid_from FROM catalog_prices WHERE store_id=${job.options.storeId}::uuid AND variant_id=${variant}::uuid AND valid_from>${now} ORDER BY valid_from LIMIT 1`.execute(
    tx,
  );
  await sql`INSERT INTO catalog_prices(id,store_id,variant_id,selling_paise,mrp_paise,valid_from,valid_to,created_by) VALUES(${uuidV7()}::uuid,${job.options.storeId}::uuid,${variant}::uuid,${row.sellingPaise}::bigint,${row.mrpPaise}::bigint,${now},${next.rows[0]?.valid_from ?? null},${job.owner_id}::uuid)`.execute(
    tx,
  );
}
