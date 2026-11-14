import { setTimeout as delay } from 'node:timers/promises';
import { sql } from 'kysely';
import { uuidV7 } from '../../../common/ids/ids.js';
import type { Database } from '../../../platform/database/database.js';
import type { IdentityAdminPort, Role } from '../contracts/identity.js';

/** Creates with a stable provider username. Ambiguous calls are resolved before another create. */
export class WorkforceProvisioning {
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
    // Stable provider usernames make concurrent create attempts converge on one remote user.
    const created = await this.db.transaction().execute(async (tx) => {
      const actor = await sql<{
        id: string;
      }>`SELECT u.id FROM users u JOIN user_roles r ON r.user_id=u.id WHERE u.id=${actorId}::uuid AND u.pool='WORKFORCE' AND u.status='ACTIVE' AND r.role IN ('SUPER_ADMIN') FOR SHARE OF u,r`.execute(
        tx,
      );
      if (!actor.rows[0]) throw new Error('FORBIDDEN');
      return sql<{
        id: string;
        username: string;
        name: string;
        role: Role;
        state: string;
        cognito_sub: string | null;
      }>`INSERT INTO identity_provisioning(id,normalized_email,username,name,role,state)
        VALUES (${op}::uuid,${email},${`workforce-${op}`},${name},${role},'REQUESTED')
        ON CONFLICT(normalized_email) DO UPDATE SET normalized_email=EXCLUDED.normalized_email
        RETURNING id,username,name,role,state,cognito_sub`.execute(tx);
    });
    const row = created.rows[0];
    if (!row || row.name !== name || row.role !== role)
      throw new Error('PROVISIONING_INPUT_CONFLICT');
    const lease = uuidV7();
    let acquired = false;
    for (let attempt = 0; attempt < 100 && !acquired; attempt++) {
      const claim =
        await sql`UPDATE identity_provisioning SET lease_token=${lease}::uuid,lease_until=clock_timestamp()+interval '60 seconds' WHERE id=${row.id}::uuid AND (lease_until IS NULL OR lease_until<=clock_timestamp())`.execute(
          this.db,
        );
      acquired = Number(claim.numAffectedRows ?? 0) === 1;
      if (!acquired) await delay(100);
    }
    if (!acquired) throw new Error('PROVISIONING_IN_PROGRESS');
    try {
      return await this.resume(actorId, row.id, lease, email, name, role);
    } finally {
      await sql`UPDATE identity_provisioning SET lease_token=NULL,lease_until=NULL WHERE id=${row.id}::uuid AND lease_token=${lease}::uuid`.execute(
        this.db,
      );
    }
  }
  private async resume(
    actorId: string,
    operationId: string,
    lease: string,
    email: string,
    name: string,
    role: Role,
  ): Promise<{ operationId: string; userId: string }> {
    const current = await sql<{
      id: string;
      username: string;
      state: string;
      cognito_sub: string | null;
    }>`SELECT id,username,state,cognito_sub FROM identity_provisioning WHERE id=${operationId}::uuid AND lease_token=${lease}::uuid`.execute(
      this.db,
    );
    const row = current.rows[0];
    if (!row) throw new Error('PROVISIONING_LEASE_LOST');
    if (row.state === 'COMPENSATION_REQUIRED') {
      await this.provider.delete(row.username);
      await sql`UPDATE identity_provisioning SET state='REQUESTED',cognito_sub=NULL,updated_at=clock_timestamp() WHERE id=${row.id}::uuid AND lease_token=${lease}::uuid`.execute(
        this.db,
      );
      row.state = 'REQUESTED';
      row.cognito_sub = null;
    }
    let sub = row.cognito_sub;
    if (!sub) {
      const existing = await this.provider.find(row.username);
      if (existing) sub = existing.sub;
      else {
        try {
          sub = (await this.provider.create(row.username, email, name)).sub;
        } catch (error: unknown) {
          // A competing create or a lost response may have created the same unique username.
          const recovered = await this.provider.find(row.username);
          if (!recovered) throw error;
          sub = recovered.sub;
        }
      }
      await sql`UPDATE identity_provisioning SET cognito_sub=${sub},state='REMOTE_CREATED',updated_at=clock_timestamp() WHERE id=${row.id}::uuid AND state='REQUESTED'`.execute(
        this.db,
      );
    }
    // Ensure newly issued Cognito tokens contain the role required by intersection checks.
    await this.provider.addToGroup(row.username, role);
    const providerSub = sub;
    try {
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
        }>`SELECT state,cognito_sub FROM identity_provisioning WHERE id=${row.id}::uuid FOR UPDATE`.execute(
          tx,
        );
        if (
          !locked.rows[0] ||
          locked.rows[0].cognito_sub !== providerSub ||
          locked.rows[0].state === 'COMPENSATION_REQUIRED'
        )
          throw new Error('PROVISIONING_CONFLICT');
        const id = uuidV7();
        const user = await sql<{
          id: string;
        }>`INSERT INTO users(id,pool,cognito_sub,normalized_email,name,email_verified) VALUES (${id}::uuid,'WORKFORCE',${providerSub},${email},${name},false)
        ON CONFLICT(pool,cognito_sub) DO UPDATE SET cognito_sub=EXCLUDED.cognito_sub RETURNING id`.execute(
          tx,
        );
        const userId = user.rows[0]?.id;
        if (!userId) throw new Error('PROVISIONING_FAILED');
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
    } catch (error: unknown) {
      // If commit status is ambiguous, inspect durable state before compensating.
      const state = await sql<{
        state: string;
      }>`SELECT state FROM identity_provisioning WHERE id=${row.id}::uuid AND lease_token=${lease}::uuid`.execute(
        this.db,
      );
      if (state.rows[0]?.state !== 'COMPLETE') {
        await sql`UPDATE identity_provisioning SET state='COMPENSATION_REQUIRED',updated_at=clock_timestamp() WHERE id=${row.id}::uuid AND lease_token=${lease}::uuid AND state<>'COMPLETE'`.execute(
          this.db,
        );
        try {
          await this.provider.delete(row.username);
          await sql`UPDATE identity_provisioning SET state='REQUESTED',cognito_sub=NULL,updated_at=clock_timestamp() WHERE id=${row.id}::uuid AND lease_token=${lease}::uuid AND state='COMPENSATION_REQUIRED'`.execute(
            this.db,
          );
        } catch {
          /* A later invocation retries durable compensation. */
        }
      }
      throw error;
    }
  }
}
