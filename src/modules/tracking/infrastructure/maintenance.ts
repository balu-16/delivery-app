import { sql } from 'kysely';
import type { Database } from '../../../platform/database/database.js';

/**
 * Partition + retention maintenance for rider_location_history (plan 6.1):
 * creates tomorrow's partition before midnight and drops partitions older
 * than the retention window. Idempotent and safe to run twice or late.
 */
export class TrackingMaintenance {
  constructor(
    private readonly db: Database,
    private readonly retentionDays: number,
  ) {}

  async runOnce(): Promise<{ created: number; dropped: number }> {
    const created = await this.ensurePartitions();
    const dropped = await this.dropExpired();
    return { created, dropped };
  }

  private async ensurePartitions(): Promise<number> {
    const result = await sql<{
      created: number;
    }>`SELECT ensure_location_partitions(((clock_timestamp() AT TIME ZONE 'UTC')::date + 2)) AS created`.execute(
      this.db,
    );
    return Number(result.rows[0]?.created ?? 0);
  }

  private async dropExpired(): Promise<number> {
    const days = Math.max(1, Math.trunc(this.retentionDays));
    const rows = await sql<{ relname: string }>`SELECT c.relname FROM pg_class c
      JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE c.relkind='r' AND n.nspname='public' AND c.relname ~ '^rider_location_history_[0-9]{8}$'
        AND to_date(right(c.relname, 8), 'YYYYMMDD')::timestamp AT TIME ZONE 'UTC' + interval '2 days' < clock_timestamp() - ${days} * interval '1 day'`.execute(
      this.db,
    );
    let dropped = 0;
    for (const row of rows.rows) {
      const label = row.relname.replace('rider_location_history_', '');
      if (!/^\d{8}$/.test(label)) continue;
      await sql`SELECT drop_location_partition(${`${label.slice(0, 4)}-${label.slice(4, 6)}-${label.slice(6, 8)}`}::date)`.execute(
        this.db,
      );
      dropped += 1;
    }
    return dropped;
  }
}
