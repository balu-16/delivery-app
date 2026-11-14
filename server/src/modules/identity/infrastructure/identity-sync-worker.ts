import { sql } from 'kysely';
import { uuidV7 } from '../../../common/ids/ids.js';
import type { Database, Json } from '../../../platform/database/database.js';
import type { IdentityAdminPort, Pool, Role } from '../contracts/identity.js';

interface Operation {
  id: string;
  user_id: string;
  token: string;
  action: string;
  details: Json;
  pool: Pool;
  username: string;
}
/** External operations run outside transactions; a lease makes a crashed attempt recoverable. */
export class IdentitySyncWorker {
  constructor(
    private readonly db: Database,
    private readonly providers: Record<Pool, IdentityAdminPort>,
    private readonly leaseSeconds = 60,
    private readonly allowCompensation = true,
  ) {}
  async compensateOne(): Promise<boolean> {
    if (!this.allowCompensation) return false;
    const token = uuidV7();
    const operation = await this.db.transaction().execute(async (tx) => {
      const result = await sql<{
        id: string;
        username: string;
      }>`SELECT id,username FROM identity_provisioning WHERE state='COMPENSATION_REQUIRED' AND compensation_next_attempt_at<=clock_timestamp() AND (lease_until IS NULL OR lease_until<=clock_timestamp()) ORDER BY updated_at FOR UPDATE SKIP LOCKED LIMIT 1`.execute(
        tx,
      );
      const row = result.rows[0];
      if (!row) return null;
      await sql`UPDATE identity_provisioning SET lease_token=${token}::uuid,lease_until=clock_timestamp()+${this.leaseSeconds}*interval '1 second',compensation_attempts=compensation_attempts+1 WHERE id=${row.id}::uuid`.execute(
        tx,
      );
      return row;
    });
    if (!operation) return false;
    try {
      await this.providers.WORKFORCE.delete(operation.username);
      await sql`UPDATE identity_provisioning SET state='REQUESTED',cognito_sub=NULL,lease_token=NULL,lease_until=NULL,updated_at=clock_timestamp() WHERE id=${operation.id}::uuid AND lease_token=${token}::uuid AND state='COMPENSATION_REQUIRED'`.execute(
        this.db,
      );
    } catch {
      await sql`UPDATE identity_provisioning SET lease_token=NULL,lease_until=NULL,compensation_next_attempt_at=clock_timestamp()+LEAST(300,power(2,LEAST(compensation_attempts,8)))*interval '1 second' WHERE id=${operation.id}::uuid AND lease_token=${token}::uuid`.execute(
        this.db,
      );
    }
    return true;
  }
  async runOne(): Promise<boolean> {
    const token = uuidV7();
    const operation = await this.db.transaction().execute(async (tx) => {
      const result = await sql<{
        id: string;
        user_id: string;
        action: string;
        details: Json;
        pool: Pool;
        username: string;
      }>`SELECT o.id,o.user_id,o.action,o.details,u.pool,COALESCE(p.username,u.cognito_sub) AS username
        FROM identity_sync_operations o JOIN users u ON u.id=o.user_id LEFT JOIN identity_provisioning p ON p.cognito_sub=u.cognito_sub AND u.pool='WORKFORCE'
        WHERE o.state<>'COMPLETE' AND o.next_attempt_at<=clock_timestamp() AND (o.state='REQUESTED' OR o.lease_until<=clock_timestamp())
          AND NOT EXISTS (SELECT 1 FROM identity_sync_operations earlier WHERE earlier.user_id=o.user_id AND earlier.seq<o.seq AND earlier.state<>'COMPLETE')
        ORDER BY o.seq FOR UPDATE OF o SKIP LOCKED LIMIT 1`.execute(tx);
      const row = result.rows[0];
      if (!row) return null;
      await sql`UPDATE identity_sync_operations SET state='RUNNING',lease_token=${token}::uuid,lease_until=clock_timestamp()+${this.leaseSeconds}*interval '1 second',attempts=attempts+1 WHERE id=${row.id}::uuid`.execute(
        tx,
      );
      return { ...row, token };
    });
    if (!operation) return false;
    try {
      await this.apply(operation);
      await sql`UPDATE identity_sync_operations SET state='COMPLETE',lease_token=NULL,lease_until=NULL,completed_at=clock_timestamp() WHERE id=${operation.id}::uuid AND lease_token=${operation.token}::uuid`.execute(
        this.db,
      );
    } catch {
      await sql`UPDATE identity_sync_operations SET state='REQUESTED',lease_token=NULL,lease_until=NULL,next_attempt_at=clock_timestamp()+ LEAST(300,power(2,LEAST(attempts,8))) * interval '1 second' WHERE id=${operation.id}::uuid AND lease_token=${operation.token}::uuid`.execute(
        this.db,
      );
    }
    return true;
  }
  private async apply(operation: Operation): Promise<void> {
    const provider = this.providers[operation.pool];
    if (operation.action === 'USER_BLOCKED') return provider.disable(operation.username);
    if (operation.action === 'USER_UNBLOCKED') return provider.enable(operation.username);
    if (operation.action === 'PASSWORD_RESET_REQUESTED')
      return provider.forcePasswordReset(operation.username);
    if (
      !operation.details ||
      typeof operation.details !== 'object' ||
      Array.isArray(operation.details) ||
      typeof operation.details.role !== 'string'
    )
      throw new Error('INVALID_SYNC_OPERATION');
    const role = operation.details.role as Role;
    if (operation.action === 'ROLE_GRANTED') {
      // Do not replay an old grant after the database role has changed.
      const current = await sql`SELECT 1 FROM users u JOIN user_roles r ON r.user_id=u.id
        WHERE u.id=${operation.user_id}::uuid AND u.pool=${operation.pool}
          AND u.status='ACTIVE' AND r.role=${role}`.execute(this.db);
      if (!current.rows.length) return;
      return provider.addToGroup(operation.username, role);
    }
    if (operation.action === 'ROLE_REMOVED')
      return provider.removeFromGroup(operation.username, role);
    throw new Error('INVALID_SYNC_OPERATION');
  }
}
