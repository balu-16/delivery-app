import { sql } from 'kysely';
import { uuidV7 } from '../../../common/ids/ids.js';
import {
  databaseTimeAfterLock,
  transactionWithRetry,
  type Database,
  type TransactionContext,
} from '../../../platform/database/database.js';
import type {
  HeartbeatInput,
  RiderMeView,
  RiderOperations,
  RiderStatusView,
  ShiftEndReason,
} from '../contracts/riders.js';
import { assertCanGoOnline } from '../domain/policy.js';

interface StatusRow {
  rider_id: string;
  online: boolean;
  on_break?: boolean;
  last_heartbeat_at: Date | null;
  last_location_at: Date | null;
  active_tasks: number;
  idle_since: Date | null;
  unreachable_since: Date | null;
}

export function mapStatus(row: StatusRow): RiderStatusView {
  return {
    riderId: row.rider_id,
    online: row.online,
    onBreak: row.on_break ?? false,
    lastHeartbeatAt: row.last_heartbeat_at?.toISOString() ?? null,
    lastLocationAt: row.last_location_at?.toISOString() ?? null,
    activeTasks: row.active_tasks,
    idleSince: row.idle_since?.toISOString() ?? null,
    unreachableSince: row.unreachable_since?.toISOString() ?? null,
  };
}

async function ensureRow(tx: TransactionContext, riderId: string): Promise<void> {
  await sql`INSERT INTO rider_status(rider_id) VALUES(${riderId}::uuid) ON CONFLICT DO NOTHING`.execute(
    tx,
  );
}

/** Operational rider state; approval authority remains with the P1 profile. */
export class PostgresRiderOperations implements RiderOperations {
  constructor(private readonly db: Database) {}
  async setBreak(riderId: string, onBreak: boolean): Promise<RiderStatusView> {
    return this.run(async (tx) => {
      const result =
        await sql<StatusRow>`UPDATE rider_status SET on_break=${onBreak},version=version+1
        WHERE rider_id=${riderId}::uuid AND online RETURNING *`.execute(tx);
      if (!result.rows[0]) throw new Error('RIDER_OFFLINE');
      return mapStatus(result.rows[0]);
    });
  }
  private run<T>(fn: (tx: TransactionContext) => Promise<T>): Promise<T> {
    return transactionWithRetry(this.db, fn);
  }

  async goOnline(riderId: string, _reference: string): Promise<RiderStatusView> {
    return this.run(async (tx) => {
      await ensureRow(tx, riderId);
      const locked = await sql<
        StatusRow & { profile_status: string }
      >`SELECT s.rider_id,s.online,s.on_break,s.last_heartbeat_at,s.last_location_at,s.active_tasks,s.idle_since,s.unreachable_since,p.status AS profile_status
        FROM rider_status s JOIN rider_profiles p ON p.user_id=s.rider_id
        WHERE s.rider_id=${riderId}::uuid FOR UPDATE OF s`.execute(tx);
      const row = locked.rows[0];
      if (!row) throw new Error('RESOURCE_NOT_FOUND');
      assertCanGoOnline(row.profile_status);
      const now = await databaseTimeAfterLock(tx);
      if (!row.online) {
        await sql`UPDATE rider_status SET online=true,on_break=false,unreachable_since=NULL,idle_since=CASE WHEN active_tasks=0 THEN clock_timestamp() ELSE idle_since END,version=version+1 WHERE rider_id=${riderId}::uuid`.execute(
          tx,
        );
      }
      const open = await sql<{
        id: string;
      }>`SELECT id FROM rider_shifts WHERE rider_id=${riderId}::uuid AND ended_at IS NULL`.execute(
        tx,
      );
      if (!open.rows[0])
        await sql`INSERT INTO rider_shifts(id,rider_id,started_at) VALUES(${uuidV7()}::uuid,${riderId}::uuid,${now.toISOString()}::timestamptz)`.execute(
          tx,
        );
      return mapStatus({ ...row, online: true, on_break: row.online ? row.on_break : false });
    });
  }

  async goOffline(riderId: string, _reference: string): Promise<RiderStatusView> {
    return this.run(async (tx) => {
      await ensureRow(tx, riderId);
      const locked =
        await sql<StatusRow>`SELECT rider_id,online,on_break,last_heartbeat_at,last_location_at,active_tasks,idle_since,unreachable_since
        FROM rider_status WHERE rider_id=${riderId}::uuid FOR UPDATE`.execute(tx);
      const row = locked.rows[0];
      if (!row) throw new Error('RESOURCE_NOT_FOUND');
      const now = await databaseTimeAfterLock(tx);
      if (row.online) {
        const reason: ShiftEndReason = row.active_tasks > 0 ? 'SYSTEM' : 'RIDER';
        await sql`UPDATE rider_shifts SET ended_at=${now.toISOString()}::timestamptz,end_reason=${reason} WHERE rider_id=${riderId}::uuid AND ended_at IS NULL`.execute(
          tx,
        );
        await sql`UPDATE rider_status SET online=false,on_break=false,idle_since=CASE WHEN active_tasks=0 THEN ${now.toISOString()}::timestamptz ELSE NULL END,version=version+1 WHERE rider_id=${riderId}::uuid`.execute(
          tx,
        );
      }
      return mapStatus({ ...row, online: false, on_break: false });
    });
  }

  async heartbeat(riderId: string, _input: HeartbeatInput, at?: Date): Promise<RiderStatusView> {
    return this.run(async (tx) => {
      await ensureRow(tx, riderId);
      const locked =
        await sql<StatusRow>`SELECT rider_id,online,on_break,last_heartbeat_at,last_location_at,active_tasks,idle_since,unreachable_since
        FROM rider_status WHERE rider_id=${riderId}::uuid FOR UPDATE`.execute(tx);
      const row = locked.rows[0];
      if (!row) throw new Error('RESOURCE_NOT_FOUND');
      const now = await databaseTimeAfterLock(tx);
      const stamp = at ?? now;
      await sql`UPDATE rider_status SET last_heartbeat_at=${stamp.toISOString()}::timestamptz,unreachable_since=NULL,version=version+1 WHERE rider_id=${riderId}::uuid AND online`.execute(
        tx,
      );
      const fresh =
        await sql<StatusRow>`SELECT rider_id,online,on_break,last_heartbeat_at,last_location_at,active_tasks,idle_since,unreachable_since
        FROM rider_status WHERE rider_id=${riderId}::uuid`.execute(tx);
      return mapStatus(fresh.rows[0]!);
    });
  }

  async me(riderId: string): Promise<RiderMeView> {
    return this.run(async (tx) => {
      await ensureRow(tx, riderId);
      const rows = await sql<
        StatusRow & { profile_status: string }
      >`SELECT s.rider_id,s.online,s.on_break,s.last_heartbeat_at,s.last_location_at,s.active_tasks,s.idle_since,s.unreachable_since,p.status AS profile_status
        FROM rider_status s JOIN rider_profiles p ON p.user_id=s.rider_id
        WHERE s.rider_id=${riderId}::uuid`.execute(tx);
      const row = rows.rows[0];
      if (!row) throw new Error('RESOURCE_NOT_FOUND');
      const shift = await sql<{
        id: string;
        started_at: Date;
        ended_at: Date | null;
        end_reason: ShiftEndReason | null;
      }>`SELECT id,started_at,ended_at,end_reason FROM rider_shifts WHERE rider_id=${riderId}::uuid AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1`.execute(
        tx,
      );
      const open = shift.rows[0];
      return {
        riderId: row.rider_id,
        profileStatus: row.profile_status,
        status: mapStatus(row),
        currentShift: open
          ? {
              id: open.id,
              startedAt: open.started_at.toISOString(),
              endedAt: open.ended_at?.toISOString() ?? null,
              endReason: open.end_reason,
            }
          : null,
      };
    });
  }
}
