import { SignJWT, jwtVerify } from 'jose';
import { sql } from 'kysely';
import { type Database } from '../../platform/database/database.js';
import type {
  Audience,
  Pool,
  TokenUse,
  TokenVerifier,
  VerifiedIdentity,
} from '../../modules/identity/contracts/identity.js';

/** Local-only signer; never register in production. Identities still resolve from PostgreSQL. */
export class LocalTokenAdapter implements TokenVerifier {
  private readonly key: Uint8Array;
  constructor(
    secret: string,
    private readonly db: Database,
  ) {
    if (secret.length < 16) throw new Error('LOCAL_TOKEN_SECRET_TOO_SHORT');
    this.key = new TextEncoder().encode(secret);
  }
  async issue(
    pool: Pool,
    sub: string,
    audience: Audience,
    tokenUse: TokenUse,
    lifetimeSeconds = 3600,
  ): Promise<string> {
    if (
      (pool === 'CUSTOMER') !== (audience === 'customer') ||
      lifetimeSeconds < 1 ||
      lifetimeSeconds > 86400
    )
      throw new Error('INVALID_LOCAL_TOKEN_REQUEST');
    const result = await sql<{
      normalized_email: string;
      name: string;
      email_verified: boolean;
      status: string;
      roles: string[];
    }>`SELECT normalized_email,name,email_verified,status,roles FROM (
      SELECT u.normalized_email,u.name,u.email_verified,u.status,COALESCE(array_agg(r.role) FILTER(WHERE r.role IS NOT NULL),'{}') AS roles,0 AS priority
      FROM users u LEFT JOIN user_roles r ON r.user_id=u.id WHERE u.pool=${pool} AND u.cognito_sub=${sub} GROUP BY u.id
      UNION ALL
      SELECT d.email,d.name,d.email_verified,CASE WHEN d.disabled THEN 'BLOCKED' ELSE 'ACTIVE' END,ARRAY[]::text[],1
      FROM local_identity_directory d WHERE d.pool=${pool} AND d.sub=${sub} AND ${tokenUse}='id'
    ) identities ORDER BY priority LIMIT 1`.execute(this.db);
    const user = result.rows[0];
    if (!user || user.status !== 'ACTIVE') throw new Error('LOCAL_USER_UNAVAILABLE');
    return new SignJWT({
      token_use: tokenUse,
      'cognito:groups': user.roles,
      email: user.normalized_email,
      email_verified: user.email_verified,
      name: user.name,
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer(`local:${pool}`)
      .setAudience(audience)
      .setSubject(sub)
      .setIssuedAt()
      .setExpirationTime(`${lifetimeSeconds}s`)
      .sign(this.key);
  }
  async verify(token: string, audience: Audience, tokenUse: TokenUse): Promise<VerifiedIdentity> {
    const pool: Pool = audience === 'customer' ? 'CUSTOMER' : 'WORKFORCE';
    const { payload } = await jwtVerify(token, this.key, {
      algorithms: ['HS256'],
      issuer: `local:${pool}`,
      audience,
      clockTolerance: 60,
    });
    if (
      payload.token_use !== tokenUse ||
      typeof payload.sub !== 'string' ||
      typeof payload.exp !== 'number'
    )
      throw new Error('INVALID_TOKEN');
    const groups = payload['cognito:groups'];
    const identity: VerifiedIdentity = {
      pool,
      sub: payload.sub,
      tokenUse,
      groups: Array.isArray(groups) ? groups.filter((v): v is string => typeof v === 'string') : [],
      expiresAt: payload.exp,
    };
    if (typeof payload.email === 'string') identity.email = payload.email;
    if (typeof payload.email_verified === 'boolean')
      identity.emailVerified = payload.email_verified;
    if (typeof payload.name === 'string') identity.name = payload.name;
    return identity;
  }
}
