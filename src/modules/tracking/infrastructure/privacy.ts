import { sql } from 'kysely';
import type { Database, TransactionContext } from '../../../platform/database/database.js';
import type { TrackingPrivacy } from '../contracts/privacy.js';
import type { RedisRiderGeo } from './redis-geo.js';
/** The caller owns the account lock; cleanup is idempotent and bounded. */
export class PostgresTrackingPrivacy implements TrackingPrivacy {
  constructor(
    private readonly db: Database,
    private readonly geo: RedisRiderGeo,
    private readonly batchSize = 1000,
  ) {}
  async fence(userId: string, tx: TransactionContext): Promise<void> {
    await sql`UPDATE rider_status SET online=false,last_location=NULL,last_location_at=NULL,last_location_source=NULL,updated_at=clock_timestamp(),version=version+1 WHERE rider_id=${userId}::uuid`.execute(
      tx,
    );
  }
  async eraseBatch(userId: string): Promise<boolean> {
    await sql`WITH batch AS (SELECT rider_id,ts FROM rider_location_history WHERE rider_id=${userId}::uuid ORDER BY ts LIMIT ${this.batchSize}) DELETE FROM rider_location_history h USING batch WHERE h.rider_id=batch.rider_id AND h.ts=batch.ts`.execute(
      this.db,
    );
    await this.geo.removeMember(userId);
    const remaining =
      await sql`SELECT 1 FROM rider_location_history WHERE rider_id=${userId}::uuid LIMIT 1`.execute(
        this.db,
      );
    return remaining.rows.length === 0;
  }
}
