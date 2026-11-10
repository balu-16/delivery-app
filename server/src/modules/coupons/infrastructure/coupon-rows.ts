import { sql } from 'kysely';
import type { Database, TransactionContext } from '../../../platform/database/database.js';
import { uuidV7 } from '../../../common/ids/ids.js';
import type { CouponPublic } from '../contracts/coupons.js';
import type { CouponRuleRow } from '../domain/coupon-policy.js';
export interface CouponRow {
  id: string;
  code: string;
  kind: 'PERCENT' | 'FLAT' | 'FREE_DELIVERY';
  value: string;
  max_cap_paise: string | null;
  min_order_paise: string;
  per_user_limit: number | null;
  global_limit: number | null;
  redeemed_count: number;
  valid_from: Date | null;
  valid_to: Date | null;
  store_id: string | null;
  category_id: string | null;
  product_id: string | null;
  excluded_variant_ids: string[];
  stackable: boolean;
  first_order_only: boolean;
  active: boolean;
  version: string;
  created_at: Date;
}
export const couponColumns = sql`id,code,kind,value::text AS value,max_cap_paise::text AS max_cap_paise,
  min_order_paise::text AS min_order_paise,per_user_limit,global_limit,redeemed_count,valid_from,valid_to,
  store_id::text AS store_id,category_id::text AS category_id,product_id::text AS product_id,
  excluded_variant_ids,stackable,first_order_only,active,version::text AS version,created_at`;
export function toPublic(row: CouponRow): CouponPublic {
  return {
    code: row.code,
    kind: row.kind,
    valuePaise: row.value,
    maxCapPaise: row.max_cap_paise,
    minOrderPaise: row.min_order_paise,
    categoryId: row.category_id,
    productId: row.product_id,
    excludedVariantIds: row.excluded_variant_ids,
    version: row.version,
  };
}
/** Projects a stored row onto the pure rule shape the domain policy consumes. */
export function toRuleRow(row: CouponRow): CouponRuleRow {
  return {
    active: row.active,
    validFrom: row.valid_from === null ? null : new Date(row.valid_from).toISOString(),
    validTo: row.valid_to === null ? null : new Date(row.valid_to).toISOString(),
    minOrderPaise: row.min_order_paise,
    storeId: row.store_id,
    categoryId: row.category_id,
    productId: row.product_id,
    excludedVariantIds: row.excluded_variant_ids,
  };
}
export async function databaseNow(db: Database | TransactionContext): Promise<Date> {
  const result = await sql<{ now: Date }>`SELECT clock_timestamp() AS now`.execute(db);
  const row = result.rows[0];
  if (!row) throw new Error('Database clock returned no row');
  return row.now;
}
export function withinWindow(row: Pick<CouponRow, 'valid_from' | 'valid_to'>, now: Date): boolean {
  return (
    (row.valid_from === null || now >= new Date(row.valid_from)) &&
    (row.valid_to === null || now < new Date(row.valid_to))
  );
}
export async function insertAudit(
  tx: TransactionContext,
  actorId: string,
  action: string,
  subjectId: string,
  details: unknown,
): Promise<void> {
  await sql`INSERT INTO audit_log(id,actor_id,action,subject_type,subject_id,details) VALUES (${uuidV7()}::uuid,${actorId}::uuid,${action},'coupon',${subjectId},${JSON.stringify(details ?? {})}::jsonb)`.execute(
    tx,
  );
}
