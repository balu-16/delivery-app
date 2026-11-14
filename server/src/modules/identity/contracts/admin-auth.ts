import type { Principal, VerifiedIdentity } from './identity.js';

/**
 * Admin portal authentication contracts (P14). The provider abstracts the
 * workforce directory (Cognito ADMIN_* flows in production, the local scrypt
 * directory in development). Callers never see provider error text; failures
 * surface as the bounded AdminAuthProviderError union below.
 */
export interface AuthTokens {
  readonly accessToken: string;
  readonly refreshToken: string;
  /** Access token lifetime in seconds as reported by the provider. */
  readonly expiresIn: number;
}

export interface AdminAuthenticated {
  readonly status: 'AUTHENTICATED';
  readonly tokens: AuthTokens;
}

export interface AdminChallenge {
  readonly status: 'CHALLENGE';
  readonly challenge: 'NEW_PASSWORD_REQUIRED';
  /** Opaque provider state; persisted server-side, never sent to the browser. */
  readonly providerSession: string;
}

export type AdminLoginOutcome = AdminAuthenticated | AdminChallenge;

/**
 * Bounded provider failure union. `invalid_credentials` deliberately covers
 * unknown accounts so login responses cannot distinguish a wrong password
 * from an unknown e-mail; `policy_violation` marks a rejected new password
 * after local validation (mapped to a generic 400 by the surface).
 */
export type AdminAuthProviderErrorKind =
  | 'invalid_credentials'
  | 'user_not_found'
  | 'challenge_required'
  | 'policy_violation'
  | 'provider_unavailable';

export class AdminAuthProviderError extends Error {
  constructor(
    readonly kind: AdminAuthProviderErrorKind,
    cause?: unknown,
  ) {
    super(`ADMIN_AUTH_${kind.toUpperCase()}`, { cause });
  }
}

/**
 * Refresh semantics are provider-specific and documented on implementations:
 * Cognito reuses the refresh token and returns a new access token; the local
 * provider rotates a signed refresh JWT. Both return the same shape as a
 * fresh login.
 */
export interface AdminPortalAuthProvider {
  passwordLogin(email: string, password: string): Promise<AdminLoginOutcome>;
  respondToChallenge(providerSession: string, newPassword: string): Promise<AdminAuthenticated>;
  forgotPassword(email: string): Promise<void>;
  confirmForgotPassword(
    email: string,
    confirmationCode: string,
    newPassword: string,
  ): Promise<void>;
  refresh(refreshToken: string): Promise<AdminAuthenticated>;
}

export const ADMIN_PORTAL_AUTH_PROVIDER = Symbol('ADMIN_PORTAL_AUTH_PROVIDER');

export type AdminSessionProvider = 'cognito' | 'local';

export interface AdminSessionCreated {
  /** Raw 256-bit session id; only its SHA-256 is stored. */
  readonly sessionId: string;
  /** Raw CSRF token presented to the portal JavaScript; only its hash is stored separately. */
  readonly csrfToken: string;
  readonly expiresAt: string;
}

/** Decrypted session row as consumed by the guard pipeline. */
export interface AdminSession {
  readonly sessionIdHash: string;
  readonly userId: string;
  readonly provider: AdminSessionProvider;
  readonly tokens: AuthTokens;
  readonly csrfToken: string;
  readonly idleExpiresAt: string;
  readonly absoluteExpiresAt: string;
}

export interface AdminSessionOptions {
  readonly idleSeconds?: number;
  readonly absoluteSeconds?: number;
}

export interface AdminSessionRotation {
  readonly session: AdminSessionCreated;
  readonly tokens: AuthTokens;
}

/**
 * Server-side session store for the admin portal. Session ids are stored as
 * SHA-256 hashes; provider tokens are sealed with AES-256-GCM under a keyed
 * ring (ADMIN_SESSION_KEYS_JSON). Provider calls (refresh) always happen
 * OUTSIDE any database transaction, coordinated through the atomic
 * claim/rollback sequence in `rotate`.
 */
export interface AdminSessions {
  create(
    userId: string,
    provider: AdminSessionProvider,
    tokens: AuthTokens,
    options?: AdminSessionOptions,
  ): Promise<AdminSessionCreated>;
  /** Rejects expired, revoked or unknown sessions with SESSION_EXPIRED. */
  resolve(rawSessionId: string): Promise<AdminSession>;
  /** Slides the idle window (never past the absolute deadline). */
  touch(rawSessionId: string): Promise<void>;
  /**
   * Claims the session atomically (loser receives SESSION_REPLACED), calls
   * `refreshTokens` outside any transaction, persists the child session on
   * success and rolls the claim back when the provider failed retryably.
   */
  rotate(
    rawSessionId: string,
    refreshTokens: (refreshToken: string) => Promise<AuthTokens>,
  ): Promise<AdminSessionRotation>;
  revoke(rawSessionId: string): Promise<void>;
  revokeAllForUser(userId: string): Promise<void>;
  /** Constant-time hash comparison of the presented CSRF token. */
  verifyCsrf(rawSessionId: string, presented: string): Promise<boolean>;
  /** Single-use storage for NEW_PASSWORD_REQUIRED provider state (300s TTL). */
  putChallenge(challengeId: string, value: AdminChallengeState): Promise<void>;
  takeChallenge(challengeId: string): Promise<AdminChallengeState | null>;
}

export interface AdminChallengeState {
  readonly pool: 'WORKFORCE';
  readonly username: string;
  readonly providerSession: string;
}

export interface AdminAuthenticatedContext {
  readonly identity: VerifiedIdentity;
  readonly principal: Principal;
  /** Raw session id from the cookie (replaced when rotation occurred). */
  readonly sessionId: string;
  readonly csrfToken: string;
  /** Non-null when the access token was refreshed and the cookie must be replaced. */
  readonly rotation: AdminSessionRotation | null;
}

/**
 * Full cookie-authentication pipeline shared by IdentityGuard and the
 * session bootstrap endpoint: resolve -> verify access token (refresh on
 * expiry) -> authorize -> SUPER_ADMIN -> touch idle window. `rotation` is
 * non-null when the access token had to be refreshed and the caller must
 * replace the session cookie.
 */
export interface AdminSessionAuthenticator {
  authenticate(
    rawSessionId: string,
  ): Promise<AdminAuthenticatedContext & { rotation: AdminSessionRotation | null }>;
  authenticateWithRotation(
    rawSessionId: string,
  ): Promise<AdminAuthenticatedContext & { rotation: AdminSessionRotation | null }>;
}

export const ADMIN_SESSIONS = Symbol('ADMIN_SESSIONS');
export const ADMIN_SESSION_AUTHENTICATOR = Symbol('ADMIN_SESSION_AUTHENTICATOR');

/** Refresh hit a provider outage: surfaced as 503 so the portal retries. */
export class AdminSessionUnavailable extends Error {
  constructor() {
    super('ExternalServiceUnavailable');
  }
}

/** Authorization failed inside the cookie pipeline (role revoked mid-session). */
export class AdminSessionForbidden extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
