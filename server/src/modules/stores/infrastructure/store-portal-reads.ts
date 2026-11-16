import { sql, type Kysely } from 'kysely';
import type { PlatformSchema } from '../../../platform/database/database.js';
import type { IdentityAccess } from '../../identity/contracts/identity.js';
import type {
  Page,
  StoreDetailsView,
  StorePortalStoreReads,
  StoreStatusHistoryEntry,
} from '../contracts/management.js';

interface HistoryCursor {
  version: number;
}

function decodeCursor(raw: string | undefined): HistoryCursor | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (
      parsed === null ||
      typeof parsed !== 'object' ||
      !Number.isSafeInteger((parsed as HistoryCursor).version)
    )
      return null;
    return parsed as HistoryCursor;
  } catch {
    return null;
  }
}

function encodeCursor(row: { version: string }): string {
  return Buffer.from(JSON.stringify({ version: Number(row.version) })).toString('base64url');
}

/**
 * Store-manager portal reads over store-owned data. Every read asserts the
 * caller's STORE_MANAGER assignment for the requested store, so a manager
 * can never observe another store's facts or history.
 */
export class PostgresStorePortalReads implements StorePortalStoreReads {
  constructor(
    private readonly db: Kysely<PlatformSchema>,
    private readonly identity: IdentityAccess,
  ) {}

  async details(actorId: string, storeId: string): Promise<StoreDetailsView> {
    if (!(await this.identity.hasStoreRole(actorId, storeId, ['STORE_MANAGER'])))
      throw new Error('STORE_NOT_FOUND');
    const rows = await sql<{
      id: string;
      name: string;
      status: string;
      pause_reason: string | null;
      version: string;
      lat: string | null;
      lng: string | null;
      hourly_capacity: number;
      last_order_buffer_minutes: number;
    }>`SELECT id,name,status,pause_reason,version::text,
        ST_X(location::geometry)::text AS lng, ST_Y(location::geometry)::text AS lat,
        hourly_capacity,last_order_buffer_minutes
      FROM stores WHERE id=${storeId}::uuid`.execute(this.db);
    const store = rows.rows[0];
    if (!store) throw new Error('STORE_NOT_FOUND');
    const hours = await sql<{
      weekday: number;
      start_minute: number;
      end_minute: number;
    }>`SELECT weekday,start_minute,end_minute FROM store_hours WHERE store_id=${storeId}::uuid
      ORDER BY weekday,start_minute`.execute(this.db);
    return {
      storeId: store.id,
      name: store.name,
      status: store.status as StoreDetailsView['status'],
      pauseReason: store.pause_reason,
      version: store.version,
      location:
        store.lat !== null && store.lng !== null
          ? { lat: Number(store.lat), lng: Number(store.lng) }
          : null,
      hourlyCapacity: store.hourly_capacity,
      lastOrderBufferMinutes: store.last_order_buffer_minutes,
      hours: hours.rows.map((row) => ({
        weekday: row.weekday,
        startMinute: row.start_minute,
        endMinute: row.end_minute,
      })),
    };
  }

  async statusHistory(
    actorId: string,
    storeId: string,
    cursor?: string,
    limit?: number,
  ): Promise<Page<StoreStatusHistoryEntry>> {
    if (!(await this.identity.hasStoreRole(actorId, storeId, ['STORE_MANAGER'])))
      throw new Error('STORE_NOT_FOUND');
    const page = limit ?? 20;
    if (!Number.isSafeInteger(page) || page < 1 || page > 100) throw new Error('INVALID_INPUT');
    const decoded = decodeCursor(cursor);
    if (cursor && !decoded) throw new Error('INVALID_CURSOR');
    const rows = await sql<{
      version: string;
      previous_status: string;
      status: string;
      reason: string | null;
      actor_id: string | null;
      occurred_at: Date;
    }>`SELECT version::text,previous_status,status,reason,actor_id::text AS actor_id,occurred_at
      FROM store_status_history WHERE store_id=${storeId}::uuid
      AND (${decoded ? sql`version < ${decoded.version}` : sql`true`})
      ORDER BY version DESC LIMIT ${page + 1}`.execute(this.db);
    const pageRows = rows.rows.slice(0, page);
    return {
      items: pageRows.map((row) => ({
        version: row.version,
        previousStatus: row.previous_status,
        status: row.status,
        reason: row.reason,
        actorId: row.actor_id,
        occurredAt: row.occurred_at.toISOString(),
      })),
      nextCursor:
        rows.rows.length > page && pageRows.length
          ? encodeCursor(pageRows[pageRows.length - 1]!)
          : null,
    };
  }
}
