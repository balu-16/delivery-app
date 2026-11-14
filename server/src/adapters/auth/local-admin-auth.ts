import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { SignJWT, jwtVerify } from 'jose';
import { sql } from 'kysely';
import type { Database } from '../../platform/database/database.js';
import type { Pool } from '../../modules/identity/contracts/identity.js';
import {
  AdminAuthProviderError,
  type AdminAuthenticated,
  type AdminLoginOutcome,
  type AdminPortalAuthProvider,
  type AuthTokens,
} from '../../modules/identity/contracts/admin-auth.js';

const scrypt = promisify(scryptCallback) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: { N: number; r: number; p: number },
) => Promise<Buffer>;

const SCRYPT = { N: 16384, r: 8, p: 1 } as const;
const KEY_LENGTH = 64;
const ACCESS_SECONDS = 3600;
const REFRESH_SECONDS = 12 * 3600;

/** Stored password hash format: scrypt$N$r$p$<salt hex>$<hash hex>. */
export function hashLocalPassword(password: string): Promise<string> {
  return (async () => {
    const salt = randomBytes(16);
    const derived = await scrypt(password, salt, KEY_LENGTH, SCRYPT);
    return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('hex')}$${derived.toString('hex')}`;
  })();
}

export async function verifyLocalPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, r, p, saltHex, hashHex] = parts;
  const expected = Buffer.from(hashHex ?? '', 'hex');
  if (!Number.isSafeInteger(Number(n)) || expected.length !== KEY_LENGTH) return false;
  try {
    const derived = await scrypt(password, Buffer.from(saltHex ?? '', 'hex'), KEY_LENGTH, {
      N: Number(n),
      r: Number(r),
      p: Number(p),
    });
    return derived.length === expected.length && timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

/**
 * Local development directory provider (AUTH_PROVIDER=local only, never
 * registered in production). Passwords live in local_identity_directory
 * (scrypt); access tokens are issued by the shared LocalTokenAdapter so the
 * regular verifier/guard pipeline accepts them, while refresh tokens are
 * self-verified signed JWTs that rotate on every refresh.
 */
export class LocalAdminAuthProvider implements AdminPortalAuthProvider {
  private readonly key: Uint8Array;
  constructor(
    private readonly db: Database,
    secret: string,
    private readonly issueAccessToken: (
      pool: Pool,
      sub: string,
      audience: 'admin',
      tokenUse: 'access',
      lifetimeSeconds: number,
    ) => Promise<string>,
  ) {
    if (secret.length < 16) throw new Error('LOCAL_TOKEN_SECRET_TOO_SHORT');
    this.key = new TextEncoder().encode(secret);
  }

  async passwordLogin(email: string, password: string): Promise<AdminLoginOutcome> {
    const row = await this.findDirectoryUser(email);
    if (!row?.password_hash || row.disabled)
      throw new AdminAuthProviderError('invalid_credentials');
    if (!(await verifyLocalPassword(password, row.password_hash)))
      throw new AdminAuthProviderError('invalid_credentials');
    return { status: 'AUTHENTICATED', tokens: await this.tokens(row.sub) };
  }

  async respondToChallenge(): Promise<AdminAuthenticated> {
    // The local directory has no NEW_PASSWORD_REQUIRED state; passwords are
    // provisioned through scripts/set-local-admin-password.mjs.
    throw new AdminAuthProviderError('challenge_required');
  }

  async forgotPassword(): Promise<void> {
    // Generic no-op: the local directory cannot deliver e-mail; the surface
    // still answers SENT and the runbook directs operators to the script.
  }

  async confirmForgotPassword(email: string, _code: string, newPassword: string): Promise<void> {
    const row = await this.findDirectoryUser(email);
    if (!row) throw new AdminAuthProviderError('user_not_found');
    await this.db.transaction().execute(async (tx) => {
      const updated = await sql`UPDATE local_identity_directory
        SET password_hash=${await hashLocalPassword(newPassword)}
        WHERE pool=${this.pool} AND username=${row.username}
        RETURNING username`.execute(tx);
      if (!updated.rows.length) throw new AdminAuthProviderError('user_not_found');
    });
  }

  /** Local refresh semantics: single-use signed refresh JWTs that rotate. */
  async refresh(refreshToken: string): Promise<AdminAuthenticated> {
    let sub: string;
    try {
      const { payload } = await jwtVerify(refreshToken, this.key, {
        algorithms: ['HS256'],
        issuer: 'local:admin-portal',
        audience: 'admin',
        clockTolerance: 60,
      });
      if (payload.token_use !== 'refresh' || typeof payload.sub !== 'string')
        throw new Error('INVALID_REFRESH_TOKEN');
      sub = payload.sub;
    } catch {
      throw new AdminAuthProviderError('invalid_credentials');
    }
    return { status: 'AUTHENTICATED', tokens: await this.tokens(sub) };
  }

  private pool: Pool = 'WORKFORCE';

  private async findDirectoryUser(email: string): Promise<{
    username: string;
    sub: string;
    disabled: boolean;
    password_hash: string | null;
  } | null> {
    const result = await sql<{
      username: string;
      sub: string;
      disabled: boolean;
      password_hash: string | null;
    }>`SELECT username,sub,disabled,password_hash FROM local_identity_directory
      WHERE pool=${this.pool} AND email=${email.trim().toLowerCase()} LIMIT 1`.execute(this.db);
    return result.rows[0] ?? null;
  }

  private async tokens(sub: string): Promise<AuthTokens> {
    let accessToken: string;
    try {
      accessToken = await this.issueAccessToken(this.pool, sub, 'admin', 'access', ACCESS_SECONDS);
    } catch {
      // Unknown or non-ACTIVE directory subject: keep responses generic.
      throw new AdminAuthProviderError('invalid_credentials');
    }
    const refreshToken = await new SignJWT({ token_use: 'refresh' })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer('local:admin-portal')
      .setAudience('admin')
      .setSubject(sub)
      .setIssuedAt()
      .setExpirationTime(`${REFRESH_SECONDS}s`)
      .sign(this.key);
    return { accessToken, refreshToken, expiresIn: ACCESS_SECONDS };
  }
}
