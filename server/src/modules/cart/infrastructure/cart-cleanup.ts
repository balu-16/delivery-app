import { sql } from 'kysely';
import type { Database } from '../../../platform/database/database.js';
import type { AppConfig } from '../../app-config/contracts/config.js';
/** Retention sweep: cart rows cascade to their items and quote snapshots. */
export class CartCleanup {
  constructor(
    private readonly db: Database,
    private readonly config: AppConfig,
  ) {}
  /** Deletes carts idle longer than cartRetentionDays; returns the number removed. */
  async deleteIdleCarts(): Promise<number> {
    const days = await this.config.get('cartRetentionDays');
    if (!Number.isSafeInteger(days) || days < 1) throw new Error('INVALID_INPUT');
    const result =
      await sql`DELETE FROM carts WHERE updated_at < clock_timestamp() - ${days} * interval '1 day' RETURNING id`.execute(
        this.db,
      );
    return Number(result.numAffectedRows ?? 0n);
  }
}
