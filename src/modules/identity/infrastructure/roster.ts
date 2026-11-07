import { sql } from 'kysely';
import type { Database } from '../../../platform/database/database.js';
import type { IdentityRoster, StaffMember } from '../contracts/roster.js';

type Row = { user_id: string; name: string; role: 'PICKER' | 'STORE_MANAGER' };

export class PostgresIdentityRoster implements IdentityRoster {
  constructor(private readonly db: Database) {}
  async storeStaff(
    storeId: string,
    cursor?: string,
    limit = 50,
  ): Promise<{ items: StaffMember[]; nextCursor: string | null }> {
    if (!storeId || !Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      throw new Error('INVALID_INPUT');
    let after: { name: string; userId: string } | null = null;
    if (cursor) {
      try {
        const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
        if (
          Array.isArray(parsed) &&
          parsed.length === 2 &&
          typeof parsed[0] === 'string' &&
          typeof parsed[1] === 'string'
        )
          after = { name: parsed[0], userId: parsed[1] };
      } catch {
        after = null;
      }
      if (!after) throw new Error('INVALID_CURSOR');
    }
    const rows =
      await sql<Row>`SELECT s.user_id,u.name,s.role FROM store_staff s JOIN users u ON u.id=s.user_id WHERE s.store_id=${storeId}::uuid AND (${after ? sql`(u.name,s.user_id) > (${after.name},${after.userId}::uuid)` : sql`true`}) ORDER BY u.name,s.user_id LIMIT ${limit + 1}`.execute(
        this.db,
      );
    const page = rows.rows.slice(0, limit);
    const last = page.at(-1);
    return {
      items: page.map((row) => ({ userId: row.user_id, name: row.name, role: row.role })),
      nextCursor:
        rows.rows.length > limit && last
          ? Buffer.from(JSON.stringify([last.name, last.user_id])).toString('base64url')
          : null,
    };
  }
}
