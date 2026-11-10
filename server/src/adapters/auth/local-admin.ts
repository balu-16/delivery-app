import { sql } from 'kysely';
import { uuidV7 } from '../../common/ids/ids.js';
import type { Database } from '../../platform/database/database.js';
import type { IdentityAdminPort, Pool, Role } from '../../modules/identity/contracts/identity.js';
/** Persistent local directory supports saga restart testing without real Cognito. */
export class LocalIdentityAdmin implements IdentityAdminPort {
  constructor(
    private readonly db: Database,
    private readonly pool: Pool = 'WORKFORCE',
  ) {}
  async create(username: string, email: string, name: string): Promise<{ sub: string }> {
    const sub = uuidV7();
    const result = await sql<{
      sub: string;
    }>`INSERT INTO local_identity_directory(pool,username,sub,email,name) VALUES (${this.pool},${username},${sub},${email},${name}) ON CONFLICT(pool,username) DO NOTHING RETURNING sub`.execute(
      this.db,
    );
    const created = result.rows[0];
    if (created) return created;
    const existing = await this.find(username);
    if (!existing) throw new Error('LOCAL_DIRECTORY_CREATE_FAILED');
    return existing;
  }
  async find(username: string): Promise<{ sub: string } | null> {
    const result = await sql<{
      sub: string;
    }>`SELECT sub FROM local_identity_directory WHERE pool=${this.pool} AND (username=${username} OR sub=${username})`.execute(
      this.db,
    );
    return result.rows[0] ?? null;
  }
  async addToGroup(username: string, group: Role): Promise<void> {
    if (!(await this.find(username))) throw new Error('LOCAL_USER_NOT_FOUND');
    await sql`INSERT INTO local_identity_groups(pool,username,role) SELECT pool,username,${group} FROM local_identity_directory WHERE pool=${this.pool} AND (username=${username} OR sub=${username}) ON CONFLICT DO NOTHING`.execute(
      this.db,
    );
  }
  async removeFromGroup(username: string, group: Role): Promise<void> {
    await sql`DELETE FROM local_identity_groups WHERE pool=${this.pool} AND username IN (SELECT username FROM local_identity_directory WHERE pool=${this.pool} AND (username=${username} OR sub=${username})) AND role=${group}`.execute(
      this.db,
    );
  }
  async enable(username: string): Promise<void> {
    await sql`UPDATE local_identity_directory SET disabled=false WHERE pool=${this.pool} AND (username=${username} OR sub=${username})`.execute(
      this.db,
    );
  }
  async delete(username: string): Promise<void> {
    await sql`DELETE FROM local_identity_directory WHERE pool=${this.pool} AND (username=${username} OR sub=${username})`.execute(
      this.db,
    );
  }
  async disable(username: string): Promise<void> {
    await sql`UPDATE local_identity_directory SET disabled=true WHERE pool=${this.pool} AND (username=${username} OR sub=${username})`.execute(
      this.db,
    );
  }
  async forcePasswordReset(username: string): Promise<void> {
    const user = await this.find(username);
    if (!user) throw new Error('LOCAL_USER_NOT_FOUND');
  }
}
