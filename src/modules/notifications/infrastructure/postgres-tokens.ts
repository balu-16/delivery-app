import { sql } from 'kysely';
import { uuidV7 } from '../../../common/ids/ids.js';
import type { Database } from '../../../platform/database/database.js';
import type { DeviceTokens, DeviceTokenView } from '../contracts/notifications.js';

const UUID = /^[0-9a-f-]{36}$/i;
type Platform = DeviceTokenView['platform'];
type App = DeviceTokenView['app'];

/**
 * Device-token lifecycle. Tokens are unique: registering a token that already
 * belongs to another user reassigns it (login on a new device owner), and
 * re-registration by the same owner refreshes last_seen/active.
 */
export class PostgresDeviceTokens implements DeviceTokens {
  constructor(private readonly db: Database) {}

  async register(
    userId: string,
    input: { token: string; platform: Platform; app: App; identifierType?: 'FCM_TOKEN' | 'FID' },
  ): Promise<void> {
    if (
      !UUID.test(userId) ||
      input.token.length < 16 ||
      input.token.length > 4096 ||
      /\s/u.test(input.token)
    )
      throw new Error('INVALID_INPUT');
    await sql`INSERT INTO device_tokens(id,user_id,token,platform,app,identifier_type)
      VALUES (${uuidV7()}::uuid,${userId}::uuid,${input.token},${input.platform},${input.app},${input.identifierType ?? 'FCM_TOKEN'})
      ON CONFLICT (token) DO UPDATE SET user_id=excluded.user_id,platform=excluded.platform,app=excluded.app,identifier_type=excluded.identifier_type,active=true,last_seen_at=clock_timestamp(),updated_at=clock_timestamp()`.execute(
      this.db,
    );
  }

  async unregister(userId: string, token: string): Promise<void> {
    if (!UUID.test(userId) || token.length < 16 || token.length > 4096)
      throw new Error('INVALID_INPUT');
    const removed =
      await sql`UPDATE device_tokens SET active=false,updated_at=clock_timestamp() WHERE token=${token} AND user_id=${userId}::uuid`.execute(
        this.db,
      );
    if (Number(removed.numAffectedRows ?? 0) === 0) {
      const owned = await sql<{
        id: string;
      }>`SELECT id FROM device_tokens WHERE token=${token} AND user_id=${userId}::uuid`.execute(
        this.db,
      );
      if (!owned.rows[0]) throw new Error('RESOURCE_NOT_FOUND');
    }
  }

  async list(userId: string): Promise<DeviceTokenView[]> {
    if (!UUID.test(userId)) throw new Error('INVALID_INPUT');
    const rows = await sql<{
      id: string;
      token: string;
      platform: Platform;
      app: App;
      identifier_type: 'FCM_TOKEN' | 'FID';
      active: boolean;
      last_seen_at: Date;
    }>`SELECT id,token,platform,app,identifier_type,active,last_seen_at FROM device_tokens WHERE user_id=${userId}::uuid ORDER BY last_seen_at DESC, id LIMIT 100`.execute(
      this.db,
    );
    return rows.rows.map((row) => ({
      id: row.id,
      token: maskToken(row.token),
      platform: row.platform,
      app: row.app,
      identifierType: row.identifier_type,
      active: row.active,
      lastSeenAt: row.last_seen_at.toISOString(),
    }));
  }
}

/** Tokens are credentials: only a masked prefix is ever returned. */
export function maskToken(token: string): string {
  if (token.length <= 12) return '*'.repeat(token.length);
  return `${token.slice(0, 6)}…${token.slice(-4)}`;
}
