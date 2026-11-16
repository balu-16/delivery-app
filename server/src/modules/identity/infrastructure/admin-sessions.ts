import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { sql } from 'kysely';
import type { Redis } from 'ioredis';
import { ConfigService } from '../../../config/config.service.js';
import type { Env } from '../../../config/env.schema.js';
import type { Database } from '../../../platform/database/database.js';
import {
  AdminAuthProviderError,
  AdminSessionForbidden,
  AdminSessionUnavailable,
  type AdminChallengeState,
  type AdminSession,
  type AdminSessionCreated,
  type AdminSessionOptions,
  type AdminSessionProvider,
  type AdminSessionRotation,
  type AdminSessions,
  type AuthTokens,
} from '../contracts/admin-auth.js';
import { IDENTITY_AUTHORIZER, TOKEN_VERIFIER } from '../contracts/identity.js';
import type {
  Audience,
  IdentityAuthorizer,
  Role,
  TokenVerifier,
  VerifiedIdentity,
} from '../contracts/identity.js';
import { Inject, Injectable } from '@nestjs/common';
import { ADMIN_PORTAL_AUTH_PROVIDER, ADMIN_SESSIONS } from '../contracts/admin-auth.js';
import type {
  AdminPortalAuthProvider,
  AdminSessions as AdminSessionsPort,
} from '../contracts/admin-auth.js';

const CHALLENGE_TTL_SECONDS = 300;
const CLEANUP_BATCH = 100;
/** Dedicated Redis failures must not strand authentication; challenges are retried by the portal. */
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const VERSION_PREFIX_LENGTH = 1;

/**
 * Names every storage/env touchpoint that differs between the admin and store
 * portals. Session rows share one schema; only the table, key ring, challenge
 * namespace and surfaced error codes are per-portal, keeping the records (and
 * their revocation) fully independent as required by the portal split.
 */
export interface PortalSessionNaming {
  readonly table: string;
  readonly challengePrefix: string;
  readonly keysJsonKey: keyof Env;
  readonly keyVersionKey: keyof Env;
  readonly idleSecondsKey: keyof Env;
  readonly absoluteSecondsKey: keyof Env;
  readonly keyMissingCode: string;
  readonly keysInvalidCode: string;
}

export const ADMIN_SESSION_NAMING: PortalSessionNaming = {
  table: 'admin_sessions',
  challengePrefix: 'admin:auth:challenge:',
  keysJsonKey: 'ADMIN_SESSION_KEYS_JSON',
  keyVersionKey: 'ADMIN_SESSION_KEY_VERSION',
  idleSecondsKey: 'ADMIN_SESSION_IDLE_SECONDS',
  absoluteSecondsKey: 'ADMIN_SESSION_ABSOLUTE_SECONDS',
  keyMissingCode: 'ADMIN_SESSION_KEY_MISSING',
  keysInvalidCode: 'ADMIN_SESSION_KEYS_INVALID',
};

export const STORE_SESSION_NAMING: PortalSessionNaming = {
  table: 'store_sessions',
  challengePrefix: 'store:auth:challenge:',
  keysJsonKey: 'STORE_SESSION_KEYS_JSON',
  keyVersionKey: 'STORE_SESSION_KEY_VERSION',
  idleSecondsKey: 'STORE_SESSION_IDLE_SECONDS',
  absoluteSecondsKey: 'STORE_SESSION_ABSOLUTE_SECONDS',
  keyMissingCode: 'STORE_SESSION_KEY_MISSING',
  keysInvalidCode: 'STORE_SESSION_KEYS_INVALID',
};

/** Wire format: keyVersion byte || 12-byte IV || 16-byte GCM tag || ciphertext. */
export interface SealedTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  csrfToken: string;
}

export function sealSessionTokens(payload: SealedTokens, key: Buffer, version: number): Buffer {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(payload), 'utf8'),
    cipher.final(),
  ]);
  return Buffer.concat([Buffer.from([version]), iv, cipher.getAuthTag(), ciphertext]);
}

export function openSessionTokens(
  sealed: Buffer,
  resolveKey: (version: number) => Buffer | undefined,
): SealedTokens {
  if (sealed.length < VERSION_PREFIX_LENGTH + IV_LENGTH + TAG_LENGTH)
    throw new Error('SESSION_EXPIRED');
  const key = resolveKey(sealed[0]!);
  if (!key) throw new Error('SESSION_EXPIRED');
  try {
    const iv = sealed.subarray(VERSION_PREFIX_LENGTH, VERSION_PREFIX_LENGTH + IV_LENGTH);
    const tag = sealed.subarray(
      VERSION_PREFIX_LENGTH + IV_LENGTH,
      VERSION_PREFIX_LENGTH + IV_LENGTH + TAG_LENGTH,
    );
    const ciphertext = sealed.subarray(VERSION_PREFIX_LENGTH + IV_LENGTH + TAG_LENGTH);
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
    const payload = JSON.parse(plain) as SealedTokens;
    if (
      typeof payload.accessToken !== 'string' ||
      typeof payload.refreshToken !== 'string' ||
      typeof payload.csrfToken !== 'string' ||
      typeof payload.expiresIn !== 'number'
    )
      throw new Error('SESSION_EXPIRED');
    return payload;
  } catch {
    // Tampered or wrong-key ciphertext is indistinguishable from a dead session.
    throw new Error('SESSION_EXPIRED');
  }
}

export function csrfTokenHash(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function csrfTokenMatches(presented: string, storedHash: string): boolean {
  const presentedHash = createHash('sha256').update(presented, 'utf8').digest();
  const stored = Buffer.from(storedHash, 'hex');
  return presentedHash.length === stored.length && timingSafeEqual(presentedHash, stored);
}

interface SessionRow {
  id: string;
  user_id: string;
  provider: AdminSessionProvider;
  tokens: Buffer;
  csrf_token_hash: string;
  idle_expires_at: Date;
  absolute_expires_at: Date;
  last_seen_at: Date;
  revoked_at: Date | null;
  rotated_from: string | null;
}

export function sessionHash(rawSessionId: string): string {
  if (!/^[A-Za-z0-9_-]{20,200}$/.test(rawSessionId)) throw new Error('SESSION_EXPIRED');
  return createHash('sha256').update(rawSessionId, 'utf8').digest('hex');
}

function assertTokenValue(value: string, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 8192)
    throw new Error(`${label}_INVALID`);
  return value;
}

/**
 * P14 admin portal session store. Raw session ids exist only in the cookie;
 * the database keeps SHA-256 hashes. Provider tokens are sealed with
 * AES-256-GCM under the ADMIN_SESSION_KEYS_JSON ring (version byte prefix ||
 * 12-byte IV || 16-byte auth tag || ciphertext). Refresh coordination claims
 * the row with a single atomic UPDATE so concurrent refreshes across
 * instances elect exactly one winner; the loser receives SESSION_REPLACED and
 * re-authenticates. The provider call itself runs OUTSIDE any transaction.
 */
export class AdminSessionStore implements AdminSessions {
  private readonly keys: Map<string, Buffer>;
  private readonly activeVersion: number;
  private readonly idleSeconds: number;
  private readonly absoluteSeconds: number;

  constructor(
    private readonly db: Database,
    private readonly redis: Pick<Redis, 'set' | 'getdel'>,
    config: ConfigService,
    /** Defaults reproduce the admin portal; the store portal passes its own naming. */
    private readonly naming: PortalSessionNaming = ADMIN_SESSION_NAMING,
  ) {
    // The naming keys are server-controlled constants, so the value-type unions
    // are narrowed here once instead of threading generics through get().
    this.keys = parseKeyRing(config.get(naming.keysJsonKey) as string, naming.keysInvalidCode);
    this.activeVersion = config.get(naming.keyVersionKey) as number;
    this.idleSeconds = config.get(naming.idleSecondsKey) as number;
    this.absoluteSeconds = config.get(naming.absoluteSecondsKey) as number;
  }

  /** Table fragment is a server-controlled constant, never user input. */
  private get rows() {
    return sql.raw(this.naming.table);
  }

  async create(
    userId: string,
    provider: AdminSessionProvider,
    tokens: AuthTokens,
    options?: AdminSessionOptions,
  ): Promise<AdminSessionCreated> {
    const sessionId = randomBytes(32).toString('base64url');
    const csrfToken = randomBytes(32).toString('base64url');
    const idleSeconds = clampWindow(options?.idleSeconds ?? this.idleSeconds, 60, 86400);
    const absoluteSeconds = clampWindow(
      options?.absoluteSeconds ?? this.absoluteSeconds,
      300,
      2592000,
    );
    await sql`INSERT INTO ${this.rows}
      (id,user_id,provider,tokens,csrf_token_hash,idle_expires_at,absolute_expires_at)
      VALUES (${sessionHash(sessionId)},${userId}::uuid,${provider},${this.seal(tokens, csrfToken)},
        ${csrfTokenHash(csrfToken)},
        clock_timestamp() + (${idleSeconds} * interval '1 second'),
        clock_timestamp() + (${absoluteSeconds} * interval '1 second'))`.execute(this.db);
    return {
      sessionId,
      csrfToken,
      expiresAt: new Date(Date.now() + absoluteSeconds * 1000).toISOString(),
    };
  }

  async resolve(rawSessionId: string): Promise<AdminSession> {
    const hash = sessionHash(rawSessionId);
    await this.cleanupDeleted();
    const result = await sql<SessionRow>`SELECT id,user_id::text AS user_id,provider,tokens,
      csrf_token_hash,idle_expires_at,absolute_expires_at,last_seen_at,revoked_at,rotated_from
      FROM ${this.rows} WHERE id=${hash}`.execute(this.db);
    const row = result.rows[0];
    if (!row || row.revoked_at) throw new Error('SESSION_EXPIRED');
    const now = Date.now();
    if (row.absolute_expires_at.getTime() <= now || row.idle_expires_at.getTime() <= now)
      throw new Error('SESSION_EXPIRED');
    const sealed = this.unseal(row.tokens);
    return {
      sessionIdHash: row.id,
      userId: row.user_id,
      provider: row.provider,
      tokens: {
        accessToken: sealed.accessToken,
        refreshToken: sealed.refreshToken,
        expiresIn: sealed.expiresIn,
      },
      csrfToken: sealed.csrfToken,
      idleExpiresAt: row.idle_expires_at.toISOString(),
      absoluteExpiresAt: row.absolute_expires_at.toISOString(),
    };
  }

  async touch(rawSessionId: string): Promise<void> {
    await sql`UPDATE ${this.rows}
      SET last_seen_at=clock_timestamp(),
          idle_expires_at=least(absolute_expires_at, clock_timestamp() + (${this.idleSeconds} * interval '1 second'))
      WHERE id=${sessionHash(rawSessionId)} AND revoked_at IS NULL`.execute(this.db);
  }

  async rotate(
    rawSessionId: string,
    refreshTokens: (refreshToken: string) => Promise<AuthTokens>,
  ): Promise<AdminSessionRotation> {
    const parentHash = sessionHash(rawSessionId);
    // Atomic claim: the first caller revokes the parent; concurrent callers
    // (or another instance) observe revoked_at IS NOT NULL and stop.
    const claimed = await sql<SessionRow & { claimed_revoked_at: Date }>`UPDATE ${this.rows}
      SET revoked_at=clock_timestamp(), rotated_from=id
      WHERE id=${parentHash} AND revoked_at IS NULL
        AND idle_expires_at > clock_timestamp() AND absolute_expires_at > clock_timestamp()
      RETURNING id,user_id::text AS user_id,provider,tokens,csrf_token_hash,idle_expires_at,
        absolute_expires_at,last_seen_at,revoked_at,rotated_from,revoked_at AS claimed_revoked_at`.execute(
      this.db,
    );
    const parent = claimed.rows[0];
    if (!parent) throw new Error('SESSION_REPLACED');
    const parentTokens = this.unseal(parent.tokens);
    let fresh: AuthTokens;
    try {
      // Provider I/O deliberately outside the database transaction window.
      fresh = await refreshTokens(parentTokens.refreshToken);
    } catch (error: unknown) {
      const retryable =
        error instanceof AdminAuthProviderError && error.kind === 'provider_unavailable';
      if (!retryable) throw new Error('SESSION_EXPIRED', { cause: error });
      // Roll the claim back so the client can retry the refresh unchanged.
      await sql`UPDATE ${this.rows} SET revoked_at=NULL, rotated_from=NULL
        WHERE id=${parentHash} AND revoked_at=${parent.claimed_revoked_at.toISOString()}::timestamptz
          AND rotated_from=${parentHash}`.execute(this.db);
      throw new AdminAuthProviderError('provider_unavailable', error);
    }
    assertTokenValue(fresh.accessToken, 'ACCESS_TOKEN');
    assertTokenValue(fresh.refreshToken, 'REFRESH_TOKEN');
    const sessionId = randomBytes(32).toString('base64url');
    const csrfToken = randomBytes(32).toString('base64url');
    await sql`INSERT INTO ${this.rows}
      (id,user_id,provider,tokens,csrf_token_hash,idle_expires_at,absolute_expires_at,rotated_from)
      VALUES (${sessionHash(sessionId)},${parent.user_id}::uuid,${parent.provider},
        ${this.seal(fresh, csrfToken)},
        ${csrfTokenHash(csrfToken)},
        clock_timestamp() + (${this.idleSeconds} * interval '1 second'),
        clock_timestamp() + (${this.absoluteSeconds} * interval '1 second'),
        ${parentHash})`.execute(this.db);
    return {
      session: {
        sessionId,
        csrfToken,
        expiresAt: new Date(Date.now() + this.absoluteSeconds * 1000).toISOString(),
      },
      tokens: fresh,
    };
  }

  async revoke(rawSessionId: string): Promise<void> {
    await sql`UPDATE ${this.rows} SET revoked_at=clock_timestamp()
      WHERE id=${sessionHash(rawSessionId)} AND revoked_at IS NULL`.execute(this.db);
  }

  async revokeAllForUser(userId: string): Promise<void> {
    await sql`UPDATE ${this.rows} SET revoked_at=clock_timestamp()
      WHERE user_id=${userId}::uuid AND revoked_at IS NULL`.execute(this.db);
  }

  async verifyCsrf(rawSessionId: string, presented: string): Promise<boolean> {
    if (typeof presented !== 'string' || presented.length === 0 || presented.length > 200)
      return false;
    const result = await sql<{ csrf_token_hash: string }>`SELECT csrf_token_hash
      FROM ${this.rows} WHERE id=${sessionHash(rawSessionId)} AND revoked_at IS NULL`.execute(
      this.db,
    );
    const stored = result.rows[0]?.csrf_token_hash;
    if (!stored) return false;
    return csrfTokenMatches(presented, stored);
  }

  async putChallenge(challengeId: string, value: AdminChallengeState): Promise<void> {
    if (!/^[a-f0-9]{32}$/.test(challengeId)) throw new Error('CHALLENGE_ID_INVALID');
    await this.redis.set(
      `${this.naming.challengePrefix}${challengeId}`,
      JSON.stringify(value),
      'EX',
      CHALLENGE_TTL_SECONDS,
    );
  }

  async takeChallenge(challengeId: string): Promise<AdminChallengeState | null> {
    if (!/^[a-f0-9]{32}$/.test(challengeId)) return null;
    const raw = await this.redis.getdel(`${this.naming.challengePrefix}${challengeId}`);
    if (!raw) return null;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (
        parsed === null ||
        typeof parsed !== 'object' ||
        (parsed as { pool?: unknown }).pool !== 'WORKFORCE' ||
        typeof (parsed as { username?: unknown }).username !== 'string' ||
        typeof (parsed as { providerSession?: unknown }).providerSession !== 'string'
      )
        return null;
      return parsed as AdminChallengeState;
    } catch {
      return null;
    }
  }

  /** Opportunistic bounded delete; no scheduler is required for this table. */
  private async cleanupDeleted(): Promise<void> {
    await sql`DELETE FROM ${this.rows} WHERE id IN (
      SELECT id FROM ${this.rows} WHERE absolute_expires_at < clock_timestamp()
      ORDER BY absolute_expires_at LIMIT ${CLEANUP_BATCH})`.execute(this.db);
  }

  private seal(tokens: AuthTokens, csrfToken: string): Buffer {
    const key = this.keys.get(String(this.activeVersion));
    if (!key) throw new Error(this.naming.keyMissingCode);
    return sealSessionTokens(
      {
        accessToken: assertTokenValue(tokens.accessToken, 'ACCESS_TOKEN'),
        refreshToken: assertTokenValue(tokens.refreshToken, 'REFRESH_TOKEN'),
        expiresIn: tokens.expiresIn,
        csrfToken,
      },
      key,
      this.activeVersion,
    );
  }

  private unseal(sealed: Buffer): SealedTokens {
    return openSessionTokens(sealed, (version) => this.keys.get(String(version)));
  }
}

function clampWindow(value: number, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || value < min || value > max)
    throw new Error('INVALID_SESSION_WINDOW');
  return value;
}

function parseKeyRing(raw: string, invalidCode: string): Map<string, Buffer> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(invalidCode);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new Error(invalidCode);
  const ring = new Map<string, Buffer>();
  for (const [version, secret] of Object.entries(parsed as Record<string, unknown>)) {
    if (!/^[1-9]\d*$/.test(version) || typeof secret !== 'string') throw new Error(invalidCode);
    const key = Buffer.from(secret, 'base64');
    if (key.length !== 32) throw new Error(invalidCode);
    ring.set(version, key);
  }
  return ring;
}

/**
 * Shared cookie-authentication pipeline for IdentityGuard and the portal
 * session bootstrap endpoints: resolve the session, verify the provider access
 * token (rotating through the encrypted refresh token on expiry), authorize
 * against the portal audience, enforce the portal's single role for every
 * cookie-based request and slide the idle window. Defaults reproduce the
 * admin portal; the store portal passes audience 'store' + STORE_MANAGER.
 */
@Injectable()
export class AdminSessionAuthenticator {
  constructor(
    @Inject(ADMIN_PORTAL_AUTH_PROVIDER) private readonly provider: AdminPortalAuthProvider,
    @Inject(ADMIN_SESSIONS) private readonly sessions: AdminSessionsPort,
    @Inject(TOKEN_VERIFIER) private readonly verifier: TokenVerifier,
    @Inject(IDENTITY_AUTHORIZER) private readonly identities: IdentityAuthorizer,
    private readonly audience: Audience = 'admin',
    private readonly requiredRole: Role = 'SUPER_ADMIN',
  ) {}

  async authenticate(rawSessionId: string) {
    return this.authenticateWithRotation(rawSessionId);
  }

  async authenticateWithRotation(rawSessionId: string) {
    const session = await this.sessions.resolve(rawSessionId);
    let identity: VerifiedIdentity;
    let rotation: AdminSessionRotation | null = null;
    try {
      identity = await this.verifier.verify(session.tokens.accessToken, this.audience, 'access');
    } catch {
      try {
        rotation = await this.sessions.rotate(rawSessionId, (refreshToken) =>
          this.provider.refresh(refreshToken).then((outcome) => outcome.tokens),
        );
      } catch (error: unknown) {
        if (error instanceof AdminAuthProviderError && error.kind === 'provider_unavailable')
          throw new AdminSessionUnavailable();
        // Concurrent refresh winners replace the session; every other refresh
        // failure (definitive provider rejection, expired window) is terminal.
        if (error instanceof Error && error.message === 'SESSION_REPLACED') throw error;
        throw new Error('SESSION_EXPIRED', { cause: error });
      }
      identity = await this.verifier.verify(rotation.tokens.accessToken, this.audience, 'access');
    }
    let principal;
    try {
      principal = await this.identities.authorize(identity, this.audience);
    } catch (error: unknown) {
      const code =
        error instanceof Error &&
        ['PROFILE_NOT_INITIALIZED', 'ACCOUNT_DISABLED', 'FORBIDDEN'].includes(error.message)
          ? error.message
          : 'FORBIDDEN';
      throw new AdminSessionForbidden(code);
    }
    if (!principal.roles.includes(this.requiredRole)) throw new AdminSessionForbidden('FORBIDDEN');
    // Rotation replaced the cookie id; touch the surviving session only.
    await this.sessions.touch(rotation ? rotation.session.sessionId : rawSessionId);
    return {
      identity,
      principal,
      sessionId: rotation ? rotation.session.sessionId : rawSessionId,
      csrfToken: rotation ? rotation.session.csrfToken : session.csrfToken,
      rotation,
    };
  }
}
