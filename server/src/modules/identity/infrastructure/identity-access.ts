import { sql } from 'kysely';
import type { Database, TransactionContext } from '../../../platform/database/database.js';
import type { IdentityAccess, Pool, Principal, Role } from '../contracts/identity.js';

export class DatabaseIdentityAccess implements IdentityAccess {
  constructor(private readonly db: Database) {}
  async getPrincipal(pool: Pool, sub: string, tx?: TransactionContext): Promise<Principal | null> {
    const result = await sql<{
      id: string;
      status: Principal['status'];
      email_verified: boolean;
      auth_version: string;
      rider_status: string | null;
      roles: Role[];
    }>`SELECT u.id,u.status,u.email_verified,u.auth_version::text,rp.status AS rider_status,
      COALESCE(array_agg(ur.role) FILTER (WHERE ur.role IS NOT NULL),'{}') AS roles
      FROM users u LEFT JOIN user_roles ur ON ur.user_id=u.id LEFT JOIN rider_profiles rp ON rp.user_id=u.id
      WHERE u.pool=${pool} AND u.cognito_sub=${sub} GROUP BY u.id,rp.status`.execute(tx ?? this.db);
    const row = result.rows[0];
    return row
      ? {
          userId: row.id,
          pool,
          sub,
          roles: row.roles,
          status: row.status,
          emailVerified: row.email_verified,
          authVersion: row.auth_version,
          riderStatus: row.rider_status,
        }
      : null;
  }
  async hasRole(userId: string, roles: readonly Role[], tx?: TransactionContext): Promise<boolean> {
    if (!roles.length) return false;
    if (tx) {
      const user = await sql<{
        id: string;
      }>`SELECT id FROM users WHERE id=${userId}::uuid AND status='ACTIVE' FOR SHARE`.execute(tx);
      if (!user.rows[0]) return false;
      const matching = await sql<{
        role: Role;
      }>`SELECT role FROM user_roles WHERE user_id=${userId}::uuid AND role=ANY(${[...roles]}::text[]) ORDER BY role FOR SHARE`.execute(
        tx,
      );
      return matching.rows.length > 0;
    }
    const result = await sql<{
      allowed: boolean;
    }>`SELECT EXISTS(SELECT 1 FROM users u JOIN user_roles r ON r.user_id=u.id WHERE u.id=${userId}::uuid AND u.status='ACTIVE' AND r.role=ANY(${[...roles]}::text[])) AS allowed`.execute(
      this.db,
    );
    return result.rows[0]?.allowed === true;
  }
  async listStoreAssignments(
    userId: string,
  ): Promise<Array<{ storeId: string; role: Role; name: string }>> {
    const rows = await sql<{
      store_id: string;
      role: Role;
      name: string;
    }>`SELECT s.store_id,s.role,st.name FROM store_staff s JOIN stores st ON st.id=s.store_id JOIN users u ON u.id=s.user_id JOIN user_roles r ON r.user_id=s.user_id AND r.role=s.role WHERE s.user_id=${userId}::uuid AND u.status='ACTIVE' ORDER BY st.name,s.store_id`.execute(
      this.db,
    );
    return rows.rows.map((row) => ({ storeId: row.store_id, role: row.role, name: row.name }));
  }
  async hasStoreRole(
    userId: string,
    storeId: string,
    roles: readonly Role[],
    tx?: TransactionContext,
  ): Promise<boolean> {
    if (!roles.length) return false;
    if (tx) {
      // Mutations hold the identity rows until commit; revocations must acquire conflicting locks.
      const user = await sql<{
        id: string;
      }>`SELECT id FROM users WHERE id=${userId}::uuid AND status='ACTIVE' FOR SHARE`.execute(tx);
      if (!user.rows[0]) return false;
      const assignment = await sql<{
        role: Role;
      }>`SELECT s.role FROM store_staff s JOIN user_roles r ON r.user_id=s.user_id AND r.role=s.role
        WHERE s.user_id=${userId}::uuid AND s.store_id=${storeId}::uuid AND s.role=ANY(${[...roles]}::text[]) ORDER BY s.role FOR SHARE OF s,r`.execute(
        tx,
      );
      return assignment.rows.length > 0;
    }
    const result = await sql<{
      allowed: boolean;
    }>`SELECT EXISTS(SELECT 1 FROM store_staff s JOIN users u ON u.id=s.user_id JOIN user_roles r ON r.user_id=s.user_id AND r.role=s.role
      WHERE s.user_id=${userId}::uuid AND s.store_id=${storeId}::uuid AND s.role=ANY(${[...roles]}::text[]) AND u.status='ACTIVE') AS allowed`.execute(
      this.db,
    );
    return result.rows[0]?.allowed === true;
  }
}
