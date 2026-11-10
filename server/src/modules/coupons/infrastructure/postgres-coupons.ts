import { sql } from 'kysely';
import type { Database } from '../../../platform/database/database.js';
import type { CouponPublic, CouponValidationInput } from '../contracts/coupons.js';
import type { CouponRow } from './coupon-rows.js';
import { couponColumns, databaseNow, toPublic, toRuleRow, withinWindow } from './coupon-rows.js';
import { checkCouponRules, normalizeCode } from '../domain/coupon-policy.js';
import type { FirstOrderCheck } from '../contracts/coupons.js';
import type { CouponValidation } from '../contracts/coupons.js';

export class PostgresCoupons implements CouponValidation {
  constructor(
    private readonly db: Database,
    private readonly firstOrder: FirstOrderCheck,
  ) {}
  async validate(input: CouponValidationInput): Promise<{ coupon: CouponPublic }> {
    const db = input.tx ?? this.db;
    const code = normalizeCode(input.code);
    if (input.subtotalPaise < 0n) throw new Error('INVALID_MONEY');
    const found =
      await sql<CouponRow>`SELECT ${couponColumns} FROM coupons WHERE code=${code}${input.tx ? sql` FOR UPDATE` : sql``}`.execute(
        db,
      );
    const row = found.rows[0];
    if (!row) throw new Error('INVALID_COUPON_CODE');
    const now = await databaseNow(db);
    checkCouponRules(toRuleRow(row), now, {
      storeId: input.storeId,
      lines: input.lines,
      subtotalPaise: input.subtotalPaise,
    });
    if (row.global_limit !== null && row.redeemed_count >= row.global_limit)
      throw new Error('COUPON_EXHAUSTED');
    if (row.per_user_limit !== null) {
      const quota = await sql<{
        used: number;
      }>`SELECT reserved_count + committed_count AS used FROM coupon_user_quota WHERE coupon_id=${row.id}::uuid AND user_id=${input.userId}::uuid`.execute(
        db,
      );
      if ((quota.rows[0]?.used ?? 0) >= row.per_user_limit) throw new Error('COUPON_LIMIT_REACHED');
    }
    if (row.first_order_only && !(await this.firstOrder.isFirstOrder(input.userId, input.tx)))
      throw new Error('COUPON_NOT_ELIGIBLE');
    return { coupon: toPublic(row) };
  }
  async available(userId: string, storeId: string, subtotalPaise: bigint): Promise<CouponPublic[]> {
    if (subtotalPaise < 0n) throw new Error('INVALID_MONEY');
    const now = await databaseNow(this.db);
    const found = await sql<CouponRow>`SELECT ${couponColumns} FROM coupons WHERE active
      AND (valid_from IS NULL OR valid_from <= ${now}) AND (valid_to IS NULL OR valid_to > ${now})
      AND (store_id IS NULL OR store_id = ${storeId}::uuid)
      AND min_order_paise <= ${subtotalPaise.toString()}::bigint
      AND (global_limit IS NULL OR redeemed_count < global_limit)
      ORDER BY code LIMIT 100`.execute(this.db);
    const firstOrder = await this.firstOrder.isFirstOrder(userId);
    const result: CouponPublic[] = [];
    for (const row of found.rows) {
      if (!withinWindow(row, now)) continue;
      if (row.first_order_only && !firstOrder) continue;
      if (row.per_user_limit !== null) {
        const quota = await sql<{
          used: number;
        }>`SELECT reserved_count + committed_count AS used FROM coupon_user_quota WHERE coupon_id=${row.id}::uuid AND user_id=${userId}::uuid`.execute(
          this.db,
        );
        if ((quota.rows[0]?.used ?? 0) >= row.per_user_limit) continue;
      }
      result.push(toPublic(row));
    }
    return result;
  }
}
