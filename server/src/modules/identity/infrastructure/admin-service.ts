import { sql } from 'kysely';
import { uuidV7 } from '../../../common/ids/ids.js';
import type { Database, TransactionContext } from '../../../platform/database/database.js';
import { appendEvent } from '../../../platform/outbox/outbox.js';
import type { Pool, Role } from '../contracts/identity.js';

/** Called from an authorized admin use-case or maker-checker action. */
export class IdentityAdminService {
  constructor(private readonly db: Database) {}
  async listUsers(
    actorId: string,
    search: string,
    before?: string,
  ): Promise<{
    users: Array<{
      userId: string;
      email: string;
      name: string;
      pool: Pool;
      status: string;
      roles: Role[];
    }>;
    nextCursor: string | null;
  }> {
    if (typeof search !== 'string') throw new Error('INVALID_SEARCH');
    const query = search.trim().toLowerCase();
    if (
      query.length > 100 ||
      (before !== undefined &&
        (typeof before !== 'string' ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(before)))
    )
      throw new Error('INVALID_SEARCH');
    const actor = await sql<{
      ok: boolean;
    }>`SELECT EXISTS(SELECT 1 FROM users u JOIN user_roles r ON r.user_id=u.id WHERE u.id=${actorId}::uuid AND u.pool='WORKFORCE' AND u.status='ACTIVE' AND r.role IN ('SUPER_ADMIN')) AS ok`.execute(
      this.db,
    );
    if (!actor.rows[0]?.ok) throw new Error('FORBIDDEN');
    const result = await sql<{
      id: string;
      normalized_email: string;
      name: string;
      pool: Pool;
      status: string;
      roles: Role[];
    }>`SELECT u.id,u.normalized_email,u.name,u.pool,u.status,COALESCE(array_agg(r.role ORDER BY r.role) FILTER (WHERE r.role IS NOT NULL),'{}') AS roles FROM users u LEFT JOIN user_roles r ON r.user_id=u.id WHERE (${query}='' OR position(${query} in lower(u.name))>0 OR position(${query} in u.normalized_email)>0) AND (${before ?? null}::uuid IS NULL OR u.id<${before ?? null}::uuid) GROUP BY u.id ORDER BY u.id DESC LIMIT 51`.execute(
      this.db,
    );
    const users = result.rows.slice(0, 50).map((row) => ({
      userId: row.id,
      email: row.normalized_email,
      name: row.name,
      pool: row.pool,
      status: row.status,
      roles: row.roles,
    }));
    return { users, nextCursor: result.rows.length > 50 ? users.at(-1)!.userId : null };
  }
  async resetPassword(actorId: string, userId: string): Promise<void> {
    await this.db.transaction().execute(async (tx) => {
      await this.lockAndAuthorize(tx, actorId, userId);
      await this.audit(tx, actorId, userId, 'PASSWORD_RESET_REQUESTED');
      await sql`INSERT INTO identity_sync_operations(id,user_id,action,details) VALUES (${uuidV7()}::uuid,${userId}::uuid,'PASSWORD_RESET_REQUESTED','{}'::jsonb)`.execute(
        tx,
      );
    });
  }
  async setStoreAssignment(
    actorId: string,
    userId: string,
    storeId: string,
    role: 'STORE_MANAGER',
    grant: boolean,
  ): Promise<void> {
    if (role !== 'STORE_MANAGER') throw new Error('ROLE_NOT_MANAGED');
    await this.db.transaction().execute(async (tx) => {
      await this.lockAndAuthorize(tx, actorId, userId);
      const target = await sql<{
        ok: boolean;
      }>`SELECT EXISTS(SELECT 1 FROM users u JOIN user_roles r ON r.user_id=u.id WHERE u.id=${userId}::uuid AND u.pool='WORKFORCE' AND u.status='ACTIVE' AND r.role=${role}) AS ok`.execute(
        tx,
      );
      if (!target.rows[0]?.ok) throw new Error('ROLE_NOT_ASSIGNED');
      const store = await sql<{
        id: string;
      }>`SELECT id FROM stores WHERE id=${storeId}::uuid FOR SHARE`.execute(tx);
      if (!store.rows[0]) throw new Error('STORE_NOT_FOUND');
      if (grant)
        await sql`INSERT INTO store_staff(user_id,store_id,role) VALUES (${userId}::uuid,${storeId}::uuid,${role}) ON CONFLICT DO NOTHING`.execute(
          tx,
        );
      else
        await sql`DELETE FROM store_staff WHERE user_id=${userId}::uuid AND store_id=${storeId}::uuid AND role=${role}`.execute(
          tx,
        );
      await this.audit(tx, actorId, userId, grant ? 'STORE_ASSIGNED' : 'STORE_UNASSIGNED', {
        storeId,
        role,
      });
    });
  }
  async setBlocked(actorId: string, userId: string, blocked: boolean): Promise<void> {
    if (actorId === userId && blocked) throw new Error('CANNOT_DISABLE_SELF');
    await this.db.transaction().execute(async (tx) => {
      await this.lockAndAuthorize(tx, actorId, userId);
      if (blocked) await this.preventLastSuperAdmin(tx, userId);
      await sql`UPDATE users SET status=${blocked ? 'BLOCKED' : 'ACTIVE'},auth_version=auth_version+1,updated_at=clock_timestamp() WHERE id=${userId}::uuid AND status<>'DELETED'`.execute(
        tx,
      );
      await this.audit(tx, actorId, userId, blocked ? 'USER_BLOCKED' : 'USER_UNBLOCKED');
      await this.recordChange(tx, actorId, userId, blocked ? 'USER_BLOCKED' : 'USER_UNBLOCKED', {
        blocked,
      });
    });
  }
  async setRoleInTransaction(
    tx: TransactionContext,
    actorId: string,
    userId: string,
    role: Role,
    grant: boolean,
  ): Promise<void> {
    if (role === 'CUSTOMER') throw new Error('ROLE_NOT_MANAGED');
    await this.lockAndAuthorize(tx, actorId, userId);
    const target = await sql<{
      pool: string;
    }>`SELECT pool FROM users WHERE id=${userId}::uuid`.execute(tx);
    if (target.rows[0]?.pool !== 'WORKFORCE') throw new Error('ROLE_NOT_MANAGED');
    const existing = await sql<{
      role: Role;
    }>`SELECT role FROM user_roles WHERE user_id=${userId}::uuid FOR UPDATE`.execute(tx);
    if (existing.rows.length > 1) throw new Error('ROLE_CONFLICT');
    const previous = existing.rows[0]?.role;
    if (!grant && previous === role) throw new Error('ROLE_REPLACEMENT_REQUIRED');
    if (grant && previous && previous !== role) {
      if (previous === 'SUPER_ADMIN') await this.preventLastSuperAdmin(tx, userId);
      await sql`DELETE FROM store_staff WHERE user_id=${userId}::uuid`.execute(tx);
      await sql`DELETE FROM user_roles WHERE user_id=${userId}::uuid`.execute(tx);
      await sql`UPDATE users SET auth_version=auth_version+1,updated_at=clock_timestamp() WHERE id=${userId}::uuid`.execute(
        tx,
      );
      await this.audit(tx, actorId, userId, 'ROLE_REMOVED', { role: previous });
      await this.recordChange(tx, actorId, userId, 'ROLE_REMOVED', {
        role: previous,
        grant: false,
      });
    }
    if (grant)
      await sql`INSERT INTO user_roles(user_id,role) VALUES (${userId}::uuid,${role}) ON CONFLICT DO NOTHING`.execute(
        tx,
      );
    await sql`UPDATE users SET auth_version=auth_version+1,updated_at=clock_timestamp() WHERE id=${userId}::uuid`.execute(
      tx,
    );
    await this.audit(tx, actorId, userId, grant ? 'ROLE_GRANTED' : 'ROLE_REMOVED', { role });
    await this.recordChange(tx, actorId, userId, grant ? 'ROLE_GRANTED' : 'ROLE_REMOVED', {
      role,
      grant,
    });
  }
  private async recordChange(
    tx: TransactionContext,
    actorId: string,
    userId: string,
    action: string,
    details: Record<string, string | boolean>,
  ): Promise<void> {
    const version = await sql<{
      auth_version: string;
      occurred_at: Date;
    }>`SELECT auth_version::text,clock_timestamp() AS occurred_at FROM users WHERE id=${userId}::uuid`.execute(
      tx,
    );
    const row = version.rows[0];
    if (!row) throw new Error('USER_NOT_FOUND');
    await sql`INSERT INTO identity_status_history(id,user_id,actor_id,action,details) VALUES (${uuidV7()}::uuid,${userId}::uuid,${actorId}::uuid,${action},${JSON.stringify(details)}::jsonb)`.execute(
      tx,
    );
    const eventId = uuidV7();
    await appendEvent(
      tx,
      {
        eventId,
        eventType: `identity.${action.toLowerCase()}`,
        schemaVersion: 1,
        aggregateType: 'identity',
        aggregateId: userId,
        aggregateVersion: row.auth_version,
        occurredAt: row.occurred_at.toISOString(),
        correlationId: eventId,
        causationId: null,
        payload: { actorId, ...details },
      },
      [],
    );
    await sql`INSERT INTO identity_sync_operations(id,user_id,action,details) VALUES (${uuidV7()}::uuid,${userId}::uuid,${action},${JSON.stringify(details)}::jsonb)`.execute(
      tx,
    );
  }
  private async lockAndAuthorize(
    tx: TransactionContext,
    actorId: string,
    userId: string,
  ): Promise<void> {
    // Serializes all role/block changes that could remove the last active super-admin.
    await sql`SELECT pg_advisory_xact_lock(701002)`.execute(tx);
    const rows = await sql<{
      id: string;
      status: string;
      pool: string;
    }>`SELECT id,status,pool FROM users WHERE id=ANY(${[actorId, userId]}::uuid[]) ORDER BY id FOR UPDATE`.execute(
      tx,
    );
    const actor = rows.rows.find((row) => row.id === actorId);
    const target = rows.rows.find((row) => row.id === userId);
    if (
      !actor ||
      actor.pool !== 'WORKFORCE' ||
      actor.status !== 'ACTIVE' ||
      !target ||
      target.status === 'DELETED'
    )
      throw new Error('FORBIDDEN');
    const role = await sql<{
      ok: boolean;
    }>`SELECT EXISTS(SELECT 1 FROM user_roles WHERE user_id=${actorId}::uuid AND role='SUPER_ADMIN') AS ok`.execute(
      tx,
    );
    if (!role.rows[0]?.ok) throw new Error('FORBIDDEN');
  }
  private async preventLastSuperAdmin(tx: TransactionContext, userId: string): Promise<void> {
    const result = await sql<{
      removing_last: boolean;
    }>`SELECT EXISTS(SELECT 1 FROM user_roles WHERE user_id=${userId}::uuid AND role='SUPER_ADMIN') AND
      (SELECT count(*) FROM users u JOIN user_roles r ON r.user_id=u.id WHERE r.role='SUPER_ADMIN' AND u.status='ACTIVE') <= 1 AS removing_last`.execute(
      tx,
    );
    if (result.rows[0]?.removing_last) throw new Error('LAST_SUPER_ADMIN');
  }
  private async audit(
    tx: TransactionContext,
    actorId: string,
    userId: string,
    action: string,
    details: Record<string, string> = {},
  ): Promise<void> {
    await sql`INSERT INTO audit_log(id,actor_id,action,subject_type,subject_id,details) VALUES (${uuidV7()}::uuid,${actorId}::uuid,${action},'user',${userId},${JSON.stringify(details)}::jsonb)`.execute(
      tx,
    );
  }
}
