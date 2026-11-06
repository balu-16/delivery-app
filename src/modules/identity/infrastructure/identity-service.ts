import { sql } from 'kysely';
import { uuidV7 } from '../../../common/ids/ids.js';
import type { Database } from '../../../platform/database/database.js';
import type {
  Audience,
  IdentityAccess,
  Principal,
  VerifiedIdentity,
} from '../contracts/identity.js';
import { authorizeIdentity } from '../domain/identity-policy.js';
export class IdentityService {
  constructor(
    private readonly db: Database,
    private readonly access: IdentityAccess,
  ) {}
  async bootstrap(identity: VerifiedIdentity): Promise<Principal> {
    if (identity.pool !== 'CUSTOMER' || identity.tokenUse !== 'id' || !identity.email)
      throw new Error('INVALID_BOOTSTRAP_IDENTITY');
    const email = identity.email.trim().toLowerCase();
    if (email.length > 254 || !email.includes('@')) throw new Error('INVALID_EMAIL');
    await this.db.transaction().execute(async (tx) => {
      // Serialize a subject's initial inserts across both unique indexes.
      await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`identity:customer:${identity.sub}`}, 0))`.execute(
        tx,
      );
      // Resolve only by pool/sub: never merge an existing account by e-mail.
      const existing = await sql<{
        id: string;
        status: string;
      }>`SELECT id,status FROM users WHERE pool='CUSTOMER' AND cognito_sub=${identity.sub} FOR UPDATE`.execute(
        tx,
      );
      const found = existing.rows[0];
      if (found && found.status !== 'ACTIVE') throw new Error('ACCOUNT_DISABLED');
      const id = found?.id ?? uuidV7();
      const upserted = await sql<{
        id: string;
        status: string;
      }>`INSERT INTO users(id,pool,cognito_sub,normalized_email,name,email_verified) VALUES (${id}::uuid,'CUSTOMER',${identity.sub},${email},${identity.name?.trim().slice(0, 100) || email},${identity.emailVerified === true})
        ON CONFLICT(pool,cognito_sub) DO UPDATE SET normalized_email=EXCLUDED.normalized_email,name=EXCLUDED.name,email_verified=EXCLUDED.email_verified,updated_at=clock_timestamp() WHERE users.status='ACTIVE' RETURNING id,status`.execute(
        tx,
      );
      const actualId = upserted.rows[0]?.id;
      if (!actualId) throw new Error('ACCOUNT_DISABLED');
      await sql`INSERT INTO customer_profiles(user_id) VALUES (${actualId}::uuid) ON CONFLICT DO NOTHING`.execute(
        tx,
      );
      await sql`INSERT INTO user_roles(user_id,role) VALUES (${actualId}::uuid,'CUSTOMER') ON CONFLICT DO NOTHING`.execute(
        tx,
      );
    });
    const principal = await this.access.getPrincipal('CUSTOMER', identity.sub);
    if (!principal || principal.status !== 'ACTIVE') throw new Error('PROFILE_NOT_INITIALIZED');
    return principal;
  }
  /** Cryptographic verification occurs first; role and account state are authoritative DB reads. */
  async authorize(
    identity: VerifiedIdentity,
    audience: Audience,
    allowPendingRider = false,
  ): Promise<Principal> {
    const principal = await this.access.getPrincipal(identity.pool, identity.sub);
    return authorizeIdentity(identity, principal, audience, allowPendingRider);
  }
  async acceptConsent(
    userId: string,
    type: 'terms' | 'privacy',
    version: string,
    ip: string | null,
  ): Promise<void> {
    if (!/^[a-zA-Z0-9._-]{1,40}$/.test(version)) throw new Error('INVALID_CONSENT_VERSION');
    await this.db.transaction().execute(async (tx) => {
      const result =
        await sql`INSERT INTO consents(user_id,type,version,ip) SELECT id,${type},${version},${ip}::inet FROM users WHERE id=${userId}::uuid AND status='ACTIVE' ON CONFLICT DO NOTHING`.execute(
          tx,
        );
      if (result.numAffectedRows)
        await sql`INSERT INTO audit_log(id,actor_id,action,subject_type,subject_id,details) VALUES (${uuidV7()}::uuid,${userId}::uuid,'CONSENT_ACCEPTED','user',${userId},${JSON.stringify({ type, version })}::jsonb)`.execute(
          tx,
        );
    });
  }
  async hasConsent(userId: string, type: 'terms' | 'privacy', version: string): Promise<boolean> {
    const result = await sql<{
      ok: boolean;
    }>`SELECT EXISTS(SELECT 1 FROM consents WHERE user_id=${userId}::uuid AND type=${type} AND version=${version}) AS ok`.execute(
      this.db,
    );
    return result.rows[0]?.ok === true;
  }
}
