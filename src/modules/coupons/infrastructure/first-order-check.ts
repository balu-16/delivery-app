import { sql } from 'kysely';
import type { Database, TransactionContext } from '../../../platform/database/database.js';
import type { FirstOrderCheck } from '../contracts/coupons.js';
/**
 * Derives first-order eligibility from the authoritative orders data instead of
 * any client-provided flag. The P6 order state machine defines completion as
 * status 'DELIVERED'. While the orders tables have not arrived (P5 ships before
 * P6), the guarded probe reports every account as first-order; P6 replaces this
 * adapter wiring with the real query without changing the contract.
 */
export class PostgresFirstOrderCheck implements FirstOrderCheck {
  constructor(private readonly db: Database) {}
  async isFirstOrder(userId: string, tx?: TransactionContext): Promise<boolean> {
    const db = tx ?? this.db;
    const present = await sql<{
      present: boolean;
    }>`SELECT to_regclass('public.orders') IS NOT NULL AS present`.execute(db);
    if (!present.rows[0]?.present) return true;
    const completed =
      await sql`SELECT 1 AS one FROM orders WHERE user_id=${userId}::uuid AND status='DELIVERED' LIMIT 1`.execute(
        db,
      );
    return completed.rows.length === 0;
  }
}
