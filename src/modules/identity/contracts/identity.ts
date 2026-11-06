import type { TransactionContext } from '../../../platform/database/database.js';

export type Pool = 'CUSTOMER' | 'WORKFORCE';
export type Role =
  'CUSTOMER' | 'RIDER' | 'PICKER' | 'STORE_MANAGER' | 'SUPPORT_AGENT' | 'ADMIN' | 'SUPER_ADMIN';
export type Audience = 'customer' | 'rider' | 'store' | 'admin';
export type TokenUse = 'id' | 'access';
export interface VerifiedIdentity {
  pool: Pool;
  sub: string;
  tokenUse: TokenUse;
  groups: string[];
  email?: string;
  emailVerified?: boolean;
  name?: string;
  expiresAt: number;
}
export interface Principal {
  userId: string;
  pool: Pool;
  sub: string;
  roles: Role[];
  status: 'ACTIVE' | 'BLOCKED' | 'DELETED';
  emailVerified: boolean;
  authVersion: string;
  riderStatus: string | null;
}
export interface IdentityAccess {
  getPrincipal(pool: Pool, sub: string, tx?: TransactionContext): Promise<Principal | null>;
  hasRole(userId: string, roles: readonly Role[], tx?: TransactionContext): Promise<boolean>;
  listStoreAssignments(userId: string): Promise<Array<{ storeId: string; role: Role }>>;
  hasStoreRole(
    userId: string,
    storeId: string,
    roles: readonly Role[],
    tx?: TransactionContext,
  ): Promise<boolean>;
}
export interface TokenVerifier {
  verify(token: string, audience: Audience, tokenUse: TokenUse): Promise<VerifiedIdentity>;
}
export class IdentityProviderError extends Error {
  constructor(
    readonly code:
      'ExternalServiceRejected' | 'ExternalServiceTimeout' | 'ExternalServiceUnavailable',
    cause?: unknown,
  ) {
    super(code, { cause });
  }
}
export interface IdentityAdminPort {
  /** Stable username is the saga operation ID; lookup resolves timeout after success. */
  create(username: string, email: string, name: string): Promise<{ sub: string }>;
  find(username: string): Promise<{ sub: string } | null>;
  addToGroup(username: string, group: Role): Promise<void>;
  removeFromGroup(username: string, group: Role): Promise<void>;
  enable(username: string): Promise<void>;
  delete(username: string): Promise<void>;
  disable(username: string): Promise<void>;
  forcePasswordReset(username: string): Promise<void>;
}
export const IDENTITY_ACCESS = Symbol('IDENTITY_ACCESS');
export const TOKEN_VERIFIER = Symbol('TOKEN_VERIFIER');
export const IDENTITY_ADMIN = Symbol('IDENTITY_ADMIN');

export interface IdentityAuthorizer {
  authorize(
    identity: VerifiedIdentity,
    audience: Audience,
    allowPendingRider?: boolean,
  ): Promise<Principal>;
  bootstrap(identity: VerifiedIdentity): Promise<Principal>;
  acceptConsent(
    userId: string,
    type: 'terms' | 'privacy',
    version: string,
    ip: string | null,
  ): Promise<void>;
}
export const IDENTITY_AUTHORIZER = Symbol('IDENTITY_AUTHORIZER');
export interface UserProfiles {
  get(
    userId: string,
  ): Promise<{ userId: string; email: string; name: string; locale: string | null }>;
  update(userId: string, name: string, locale?: string): Promise<void>;
  requestErasure(userId: string): Promise<string>;
}
export interface WorkforceProvisioner {
  provision(
    actorId: string,
    email: string,
    name: string,
    role: Role,
  ): Promise<{ operationId: string; userId: string }>;
}
export const USER_PROFILES = Symbol('USER_PROFILES');
export const WORKFORCE_PROVISIONER = Symbol('WORKFORCE_PROVISIONER');
export interface IdentityAdministration {
  listUsers(
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
  }>;
  setBlocked(actorId: string, userId: string, blocked: boolean): Promise<void>;
  resetPassword(actorId: string, userId: string): Promise<void>;
  setStoreAssignment(
    actorId: string,
    userId: string,
    storeId: string,
    role: 'PICKER' | 'STORE_MANAGER',
    grant: boolean,
  ): Promise<void>;
  requestRoleChange(makerId: string, userId: string, role: Role, grant: boolean): Promise<string>;
  approveRoleChange(checkerId: string, requestId: string): Promise<void>;
}
export const IDENTITY_ADMINISTRATION = Symbol('IDENTITY_ADMINISTRATION');

export interface RiderProfileOnboarding {
  profile(userId: string, vehicleType: string, vehicleNo: string): Promise<void>;
}
export const RIDER_PROFILE_ONBOARDING = Symbol('RIDER_PROFILE_ONBOARDING');
