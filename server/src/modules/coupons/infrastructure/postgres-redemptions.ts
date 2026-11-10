import { sql } from 'kysely';
import type { Database, TransactionContext } from '../../../platform/database/database.js';
import { uuidV7 } from '../../../common/ids/ids.js';
import {
  databaseTimeAfterLock,
  transactionWithRetry,
} from '../../../platform/database/database.js';
import type { CouponRedemptions } from '../contracts/coupons.js';
import type { FirstOrderCheck } from '../contracts/coupons.js';
import { normalizeCode } from '../domain/coupon-policy.js';
import { withinWindow } from './coupon-rows.js';
interface ReservationRow {
  id: string;
  coupon_id: string;
  user_id: string;
  state: 'RESERVED' | 'COMMITTED' | 'RELEASED';
}
interface CouponLockRow {
  id: string;
  kind: 'PERCENT' | 'FLAT' | 'FREE_DELIVERY';
  global_limit: number | null;
  redeemed_count: number;
  per_user_limit: number | null;
  valid_from: Date | null;
  valid_to: Date | null;
  active: boolean;
  first_order_only: boolean;
}
interface QuotaRow {
  reserved_count: number;
  committed_count: number;
}
/**
 * Atomic quota reservation. Lock order is deterministic: coupon row first
 * (global counter), then the per-user quota row, so mixed reservations never
 * deadlock. Everything runs inside the caller's placement transaction (P6).
 */
export class PostgresCouponRedemptions implements CouponRedemptions {
  constructor(
    private readonly db: Database,
    private readonly firstOrder: FirstOrderCheck,
  ) {}
  private run<T>(
    tx: TransactionContext | undefined,
    fn: (tx: TransactionContext) => Promise<T>,
  ): Promise<T> {
    return tx ? fn(tx) : transactionWithRetry(this.db, fn);
  }
  async reserve(code: string, userId: string, outer: TransactionContext): Promise<string> {
    const normalized = normalizeCode(code);
    return this.run(outer, async (tx) => {
      const locked =
        await sql<CouponLockRow>`SELECT id,kind,global_limit,redeemed_count,per_user_limit,valid_from,valid_to,active,first_order_only
        FROM coupons WHERE code=${normalized} FOR UPDATE`.execute(tx);
      const coupon = locked.rows[0];
      if (!coupon) throw new Error('INVALID_COUPON_CODE');
      const now = await databaseTimeAfterLock(tx);
      if (!coupon.active) throw new Error('COUPON_INVALID');
      if (!withinWindow(coupon, now)) throw new Error('COUPON_EXPIRED');
      if (coupon.global_limit !== null && coupon.redeemed_count >= coupon.global_limit)
        throw new Error('COUPON_EXHAUSTED');
      if (coupon.first_order_only && !(await this.firstOrder.isFirstOrder(userId, tx)))
        throw new Error('COUPON_NOT_ELIGIBLE');
      await sql`INSERT INTO coupon_user_quota(coupon_id,user_id) VALUES(${coupon.id}::uuid,${userId}::uuid) ON CONFLICT DO NOTHING`.execute(
        tx,
      );
      const quota =
        await sql<QuotaRow>`SELECT reserved_count,committed_count FROM coupon_user_quota WHERE coupon_id=${coupon.id}::uuid AND user_id=${userId}::uuid FOR UPDATE`.execute(
          tx,
        );
      const used = (quota.rows[0]?.reserved_count ?? 0) + (quota.rows[0]?.committed_count ?? 0);
      if (coupon.per_user_limit !== null && used >= coupon.per_user_limit)
        throw new Error('COUPON_LIMIT_REACHED');
      const updated =
        await sql`UPDATE coupons SET redeemed_count=redeemed_count+1,updated_at=clock_timestamp()
        WHERE id=${coupon.id}::uuid AND (global_limit IS NULL OR redeemed_count < global_limit) RETURNING redeemed_count`.execute(
          tx,
        );
      if (!updated.rows.length) throw new Error('COUPON_EXHAUSTED');
      await sql`UPDATE coupon_user_quota SET reserved_count=reserved_count+1,updated_at=clock_timestamp() WHERE coupon_id=${coupon.id}::uuid AND user_id=${userId}::uuid`.execute(
        tx,
      );
      const reservation = await sql<{
        id: string;
      }>`INSERT INTO coupon_redemptions(id,coupon_id,user_id,state) VALUES(${uuidV7()}::uuid,${coupon.id}::uuid,${userId}::uuid,'RESERVED') RETURNING id`.execute(
        tx,
      );
      return reservation.rows[0]!.id;
    });
  }
  async commit(reservationId: string, orderId: string, outer?: TransactionContext): Promise<void> {
    await this.run(outer, async (tx) => {
      const committed =
        await sql<ReservationRow>`UPDATE coupon_redemptions SET state='COMMITTED',order_id=${orderId}::uuid,committed_at=clock_timestamp()
        WHERE id=${reservationId}::uuid AND state='RESERVED'
        RETURNING id,coupon_id::text AS coupon_id,user_id::text AS user_id,state`.execute(tx);
      const row = committed.rows[0];
      if (!row) throw new Error(await this.commitFailure(tx, reservationId));
      await sql`UPDATE coupon_user_quota SET reserved_count=reserved_count-1,committed_count=committed_count+1,updated_at=clock_timestamp()
        WHERE coupon_id=${row.coupon_id}::uuid AND user_id=${row.user_id}::uuid`.execute(tx);
    });
  }
  async release(reservationId: string, outer?: TransactionContext): Promise<void> {
    await this.run(outer, async (tx) => {
      const released =
        await sql<ReservationRow>`UPDATE coupon_redemptions SET state='RELEASED',released_at=clock_timestamp()
        WHERE id=${reservationId}::uuid AND state='RESERVED'
        RETURNING id,coupon_id::text AS coupon_id,user_id::text AS user_id,state`.execute(tx);
      const row = released.rows[0];
      if (!row) {
        const existing =
          await sql<ReservationRow>`SELECT id,coupon_id::text AS coupon_id,user_id::text AS user_id,state FROM coupon_redemptions WHERE id=${reservationId}::uuid`.execute(
            tx,
          );
        const current = existing.rows[0];
        if (!current) throw new Error('RESOURCE_NOT_FOUND');
        if (current.state === 'RELEASED') return; // Idempotent release.
        throw new Error('RESOURCE_CONFLICT');
      }
      await sql`UPDATE coupon_user_quota SET reserved_count=reserved_count-1,updated_at=clock_timestamp()
        WHERE coupon_id=${row.coupon_id}::uuid AND user_id=${row.user_id}::uuid`.execute(tx);
      await sql`UPDATE coupons SET redeemed_count=redeemed_count-1,updated_at=clock_timestamp()
        WHERE id=${row.coupon_id}::uuid AND redeemed_count > 0`.execute(tx);
    });
  }
  private async commitFailure(tx: TransactionContext, reservationId: string): Promise<string> {
    const existing =
      await sql<ReservationRow>`SELECT id,coupon_id::text AS coupon_id,user_id::text AS user_id,state FROM coupon_redemptions WHERE id=${reservationId}::uuid`.execute(
        tx,
      );
    return existing.rows[0] ? 'RESOURCE_CONFLICT' : 'RESOURCE_NOT_FOUND';
  }
}
