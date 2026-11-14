import { sql } from 'kysely';
import { uuidV7 } from '../../../common/ids/ids.js';
import type { Database } from '../../../platform/database/database.js';
import type { IdentityAdminPort, Role, WorkforceProvisioner } from '../contracts/identity.js';

/** Email-username pools cannot safely adopt or compensate an already-existing identity. */
export class SharedWorkforceProvisioning implements WorkforceProvisioner {
  constructor(
    private readonly db: Database,
    private readonly provider: IdentityAdminPort,
  ) {}

  async provision(
    actorId: string,
    emailInput: string,
    nameInput: string,
    role: Role,
  ): Promise<{ operationId: string; userId: string }> {
    const email = emailInput.trim().toLowerCase();
    const name = nameInput.trim();
    if (
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
      email.length > 254 ||
      !name ||
      name.length > 100 ||
      role === 'CUSTOMER' ||
      role === 'SUPER_ADMIN'
    )
      throw new Error('INVALID_WORKFORCE_INPUT');
    const op = uuidV7();
    const row = await this.db.transaction().execute(async (tx) => {
      const actor = await sql<{
        id: string;
      }>`SELECT u.id FROM users u JOIN user_roles r ON r.user_id=u.id WHERE u.id=${actorId}::uuid AND u.pool='WORKFORCE' AND u.status='ACTIVE' AND r.role IN ('SUPER_ADMIN') FOR SHARE OF u,r`.execute(
        tx,
      );
      if (!actor.rows[0]) throw new Error('FORBIDDEN');
      const result = await sql<{
        id: string;
        username: string;
        name: string;
        role: Role;
        state: string;
        cognito_sub: string | null;
      }>`INSERT INTO identity_provisioning(id,normalized_email,username,name,role,state) VALUES (${op}::uuid,${email},${email},${name},${role},'REQUESTED') ON CONFLICT(normalized_email) DO UPDATE SET normalized_email=EXCLUDED.normalized_email RETURNING id,username,name,role,state,cognito_sub`.execute(
        tx,
      );
      return result.rows[0];
    });
    if (!row || row.username !== email || row.name !== name || row.role !== role)
      throw new Error('PROVISIONING_INPUT_CONFLICT');
    const lease = uuidV7();
    const claim =
      await sql`UPDATE identity_provisioning SET lease_token=${lease}::uuid,lease_until=clock_timestamp()+interval '60 seconds' WHERE id=${row.id}::uuid AND (lease_until IS NULL OR lease_until<=clock_timestamp())`.execute(
        this.db,
      );
    if (Number(claim.numAffectedRows ?? 0) !== 1) throw new Error('PROVISIONING_IN_PROGRESS');
    try {
      const current = await sql<{
        state: string;
        cognito_sub: string | null;
      }>`SELECT state,cognito_sub FROM identity_provisioning WHERE id=${row.id}::uuid AND lease_token=${lease}::uuid`.execute(
        this.db,
      );
      const operation = current.rows[0];
      if (!operation) throw new Error('PROVISIONING_LEASE_LOST');
      if (operation.state === 'COMPENSATION_REQUIRED')
        throw new Error('PROVISIONING_REQUIRES_REVIEW');
      let sub = operation.cognito_sub;
      if (!sub) {
        // Never attach a role or change a user merely because its email matches.
        if (await this.provider.find(email))
          throw new Error('EXISTING_COGNITO_IDENTITY_REQUIRES_REVIEW');
        // If the response is lost, a retry finds the identity and stops for review.
        // We cannot prove that an account observed after an ambiguous create is ours.
        sub = (await this.provider.create(email, email, name)).sub;
        const saved =
          await sql`UPDATE identity_provisioning SET cognito_sub=${sub},state='REMOTE_CREATED',updated_at=clock_timestamp() WHERE id=${row.id}::uuid AND lease_token=${lease}::uuid AND state='REQUESTED' AND cognito_sub IS NULL`.execute(
            this.db,
          );
        if (Number(saved.numAffectedRows ?? 0) !== 1)
          throw new Error('PROVISIONING_REQUIRES_REVIEW');
      }
      const providerSub = sub;
      if (operation.state !== 'COMPLETE') await this.provider.addToGroup(providerSub, role);
      return await this.db.transaction().execute(async (tx) => {
        const actor = await sql<{
          id: string;
        }>`SELECT u.id FROM users u JOIN user_roles r ON r.user_id=u.id WHERE u.id=${actorId}::uuid AND u.pool='WORKFORCE' AND u.status='ACTIVE' AND r.role IN ('SUPER_ADMIN') FOR SHARE OF u,r`.execute(
          tx,
        );
        if (!actor.rows[0]) throw new Error('FORBIDDEN');
        const locked = await sql<{
          state: string;
          cognito_sub: string;
        }>`SELECT state,cognito_sub FROM identity_provisioning WHERE id=${row.id}::uuid AND lease_token=${lease}::uuid FOR UPDATE`.execute(
          tx,
        );
        if (
          !locked.rows[0] ||
          locked.rows[0].cognito_sub !== providerSub ||
          locked.rows[0].state === 'COMPENSATION_REQUIRED'
        )
          throw new Error('PROVISIONING_CONFLICT');
        const existing = await sql<{
          id: string;
          normalized_email: string;
        }>`SELECT id,normalized_email FROM users WHERE pool='WORKFORCE' AND cognito_sub=${providerSub} FOR UPDATE`.execute(
          tx,
        );
        if (locked.rows[0].state === 'COMPLETE') {
          if (!existing.rows[0] || existing.rows[0].normalized_email !== email)
            throw new Error('PROVISIONING_REQUIRES_REVIEW');
          return { operationId: row.id, userId: existing.rows[0].id };
        }
        if (existing.rows[0] && locked.rows[0].state !== 'COMPLETE')
          throw new Error('PROVISIONING_REQUIRES_REVIEW');
        const userId = existing.rows[0]?.id ?? uuidV7();
        if (!existing.rows[0])
          await sql`INSERT INTO users(id,pool,cognito_sub,normalized_email,name,email_verified) VALUES (${userId}::uuid,'WORKFORCE',${providerSub},${email},${name},false)`.execute(
            tx,
          );
        await sql`INSERT INTO staff_profiles(user_id) VALUES (${userId}::uuid) ON CONFLICT DO NOTHING`.execute(
          tx,
        );
        await sql`INSERT INTO user_roles(user_id,role) VALUES (${userId}::uuid,${role}) ON CONFLICT DO NOTHING`.execute(
          tx,
        );
        if (role === 'RIDER')
          await sql`INSERT INTO rider_profiles(user_id,status) VALUES (${userId}::uuid,'PENDING') ON CONFLICT DO NOTHING`.execute(
            tx,
          );
        if (locked.rows[0].state !== 'COMPLETE')
          await sql`INSERT INTO audit_log(id,actor_id,action,subject_type,subject_id) VALUES (${uuidV7()}::uuid,${actorId}::uuid,'WORKFORCE_CREATED','user',${userId})`.execute(
            tx,
          );
        await sql`UPDATE identity_provisioning SET state='COMPLETE',updated_at=clock_timestamp() WHERE id=${row.id}::uuid`.execute(
          tx,
        );
        return { operationId: row.id, userId };
      });
    } finally {
      await sql`UPDATE identity_provisioning SET lease_token=NULL,lease_until=NULL WHERE id=${row.id}::uuid AND lease_token=${lease}::uuid`.execute(
        this.db,
      );
    }
  }
}
