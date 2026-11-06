import { sql } from 'kysely';
import { uuidV7 } from '../../../common/ids/ids.js';
import type { Database } from '../../../platform/database/database.js';
import type { UserProfiles } from '../contracts/identity.js';
export class DatabaseUserProfiles implements UserProfiles {
  constructor(private readonly db: Database) {}
  async get(
    userId: string,
  ): Promise<{ userId: string; email: string; name: string; locale: string | null }> {
    const result = await sql<{
      id: string;
      normalized_email: string;
      name: string;
      locale: string | null;
    }>`SELECT u.id,u.normalized_email,u.name,p.locale FROM users u LEFT JOIN customer_profiles p ON p.user_id=u.id WHERE u.id=${userId}::uuid AND u.status='ACTIVE'`.execute(
      this.db,
    );
    const row = result.rows[0];
    if (!row) throw new Error('USER_NOT_FOUND');
    return { userId: row.id, email: row.normalized_email, name: row.name, locale: row.locale };
  }
  async update(userId: string, name: string, locale?: string): Promise<void> {
    if (!name.trim() || name.length > 100 || (locale && !['en', 'hi', 'te'].includes(locale)))
      throw new Error('INVALID_PROFILE');
    await this.db.transaction().execute(async (tx) => {
      await sql`UPDATE users SET name=${name.trim()},updated_at=clock_timestamp() WHERE id=${userId}::uuid AND status='ACTIVE'`.execute(
        tx,
      );
      if (locale)
        await sql`UPDATE customer_profiles SET locale=${locale} WHERE user_id=${userId}::uuid`.execute(
          tx,
        );
    });
  }
  async requestErasure(userId: string): Promise<string> {
    // P12 performs cross-domain active-resource checks, anonymization, and provider disable.
    const id = uuidV7();
    return this.db.transaction().execute(async (tx) => {
      const user = await sql<{
        id: string;
      }>`SELECT id FROM users WHERE id=${userId}::uuid AND status='ACTIVE' FOR UPDATE`.execute(tx);
      if (!user.rows[0]) throw new Error('USER_NOT_FOUND');
      const existing = await sql<{
        id: string;
      }>`SELECT id FROM erasure_requests WHERE user_id=${userId}::uuid AND status='REQUESTED'`.execute(
        tx,
      );
      if (existing.rows[0]) return existing.rows[0].id;
      await sql`INSERT INTO erasure_requests(id,user_id,status) VALUES (${id}::uuid,${userId}::uuid,'REQUESTED')`.execute(
        tx,
      );
      await sql`INSERT INTO audit_log(id,actor_id,action,subject_type,subject_id) VALUES (${uuidV7()}::uuid,${userId}::uuid,'ERASURE_REQUESTED','user',${userId})`.execute(
        tx,
      );
      return id;
    });
  }
}
