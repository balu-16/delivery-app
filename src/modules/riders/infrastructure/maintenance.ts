import { sql } from 'kysely';
import {
  databaseTimeAfterLock,
  transactionWithRetry,
  type Database,
} from '../../../platform/database/database.js';
import type { RiderSettings } from './settings.js';

/**
 * Rider maintenance sweeps (idempotent, run by the worker lifecycle):
 * - riders silent beyond the heartbeat window are marked unreachable
 *   (dispatch's own sweep decides re-dispatch versus escalation per custody),
 * - online riders past the inactivity window without tasks go offline
 *   (AUTO_INACTIVITY shift end),
 * - riders beyond the maximum continuous online hours are forced offline.
 */
export class RidersMaintenance {
  constructor(
    private readonly db: Database,
    private readonly settings: RiderSettings,
  ) {}

  async runOnce(): Promise<{ unreachable: number; autoOffline: number; maxHours: number }> {
    const now = await this.db.transaction().execute(async (tx) => databaseTimeAfterLock(tx));
    const heartbeatSeconds = await this.settings.number('riderHeartbeatStaleSeconds');
    const inactivityMinutes = await this.settings.number('riderInactivityOfflineMinutes');
    const maxHours = await this.settings.number('riderMaxContinuousHours');

    const stale = await transactionWithRetry(this.db, async (tx) => {
      const rows = await sql<{ rider_id: string }>`SELECT rider_id FROM rider_status
        WHERE online AND unreachable_since IS NULL
          AND (last_heartbeat_at IS NULL OR last_heartbeat_at < ${new Date(
            now.getTime() - heartbeatSeconds * 1000,
          ).toISOString()}::timestamptz)
        ORDER BY rider_id LIMIT 500 FOR UPDATE`.execute(tx);
      if (!rows.rows.length) return 0;
      await sql`UPDATE rider_status SET unreachable_since=clock_timestamp(),version=version+1 WHERE rider_id=ANY(${rows.rows.map((r) => r.rider_id)}::uuid[])`.execute(
        tx,
      );
      return rows.rows.length;
    });

    const offline = await transactionWithRetry(this.db, async (tx) => {
      const cutoff = new Date(now.getTime() - inactivityMinutes * 60000).toISOString();
      const idle = await sql<{ rider_id: string }>`SELECT s.rider_id FROM rider_status s
        WHERE s.online AND s.active_tasks=0
          AND (s.last_heartbeat_at IS NULL OR s.last_heartbeat_at < ${cutoff}::timestamptz)
        ORDER BY s.rider_id LIMIT 500 FOR UPDATE OF s`.execute(tx);
      if (!idle.rows.length) return 0;
      await sql`UPDATE rider_status SET online=false,idle_since=clock_timestamp(),version=version+1 WHERE rider_id=ANY(${idle.rows.map((r) => r.rider_id)}::uuid[])`.execute(
        tx,
      );
      await sql`UPDATE rider_shifts SET ended_at=clock_timestamp(),end_reason='AUTO_INACTIVITY' WHERE rider_id=ANY(${idle.rows.map((r) => r.rider_id)}::uuid[]) AND ended_at IS NULL`.execute(
        tx,
      );
      return idle.rows.length;
    });

    const exceeded = await transactionWithRetry(this.db, async (tx) => {
      const cutoff = new Date(now.getTime() - maxHours * 3600000).toISOString();
      const rows = await sql<{ rider_id: string }>`SELECT sh.rider_id FROM rider_shifts sh
        JOIN rider_status s ON s.rider_id=sh.rider_id
        WHERE sh.ended_at IS NULL AND sh.started_at < ${cutoff}::timestamptz AND s.online
        ORDER BY sh.rider_id LIMIT 500 FOR UPDATE OF s`.execute(tx);
      if (!rows.rows.length) return 0;
      await sql`UPDATE rider_status SET online=false,idle_since=clock_timestamp(),version=version+1 WHERE rider_id=ANY(${rows.rows.map((r) => r.rider_id)}::uuid[])`.execute(
        tx,
      );
      await sql`UPDATE rider_shifts SET ended_at=clock_timestamp(),end_reason='MAX_HOURS' WHERE rider_id=ANY(${rows.rows.map((r) => r.rider_id)}::uuid[]) AND ended_at IS NULL`.execute(
        tx,
      );
      return rows.rows.length;
    });

    return { unreachable: stale, autoOffline: offline, maxHours: exceeded };
  }
}
