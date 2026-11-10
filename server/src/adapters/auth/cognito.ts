import { CognitoJwtVerifier } from 'aws-jwt-verify';
import type { JwksCache } from 'aws-jwt-verify/jwk';
import {
  AdminAddUserToGroupCommand,
  AdminCreateUserCommand,
  AdminDeleteUserCommand,
  AdminDisableUserCommand,
  AdminEnableUserCommand,
  AdminRemoveUserFromGroupCommand,
  AdminGetUserCommand,
  AdminResetUserPasswordCommand,
  CognitoIdentityProviderClient,
} from '@aws-sdk/client-cognito-identity-provider';
import type {
  Audience,
  IdentityAdminPort,
  Role,
  TokenUse,
  TokenVerifier,
  VerifiedIdentity,
} from '../../modules/identity/contracts/identity.js';

export interface CognitoConfig {
  customerPoolId: string;
  customerClientId: string;
  workforcePoolId: string;
  riderClientId: string;
  storeClientId: string;
  adminClientId: string;
  region: string;
}
export class CognitoTokenVerifier implements TokenVerifier {
  constructor(
    private readonly config: CognitoConfig,
    private readonly jwksCache?: JwksCache,
  ) {}
  async verify(token: string, audience: Audience, tokenUse: TokenUse): Promise<VerifiedIdentity> {
    const pool = audience === 'customer' ? 'CUSTOMER' : 'WORKFORCE';
    const userPoolId =
      pool === 'CUSTOMER' ? this.config.customerPoolId : this.config.workforcePoolId;
    const clientId =
      audience === 'customer'
        ? this.config.customerClientId
        : audience === 'rider'
          ? this.config.riderClientId
          : audience === 'store'
            ? this.config.storeClientId
            : this.config.adminClientId;
    // Cache instances across requests so JWKS rotation and rate limiting work as documented.
    const key = `${audience}:${tokenUse}`;
    let verifier = this.verifiers.get(key);
    if (!verifier) {
      verifier = CognitoJwtVerifier.create(
        { userPoolId, clientId, tokenUse, graceSeconds: 60 },
        this.jwksCache ? { jwksCache: this.jwksCache } : undefined,
      );
      this.verifiers.set(key, verifier);
    }
    const claims = await verifier.verify(token);
    const groups = claims['cognito:groups'];
    const identity: VerifiedIdentity = {
      pool,
      sub: claims.sub,
      tokenUse,
      groups: Array.isArray(groups) ? groups.filter((x): x is string => typeof x === 'string') : [],
      expiresAt: claims.exp,
    };
    if (typeof claims.email === 'string') identity.email = claims.email;
    if (typeof claims.email_verified === 'boolean') identity.emailVerified = claims.email_verified;
    if (typeof claims.name === 'string') identity.name = claims.name;
    return identity;
  }
  private readonly verifiers = new Map<string, ReturnType<typeof CognitoJwtVerifier.create>>();
}

/** Workforce pool must use a stable username with email as a sign-in alias. */
export class CognitoIdentityAdmin implements IdentityAdminPort {
  constructor(
    private readonly client: CognitoIdentityProviderClient,
    private readonly userPoolId: string,
    private readonly timeoutMs = 3000,
  ) {}
  async create(username: string, email: string, name: string): Promise<{ sub: string }> {
    const result = await this.client.send(
      new AdminCreateUserCommand({
        UserPoolId: this.userPoolId,
        Username: username,
        UserAttributes: [
          { Name: 'email', Value: email },
          { Name: 'name', Value: name },
        ],
        DesiredDeliveryMediums: ['EMAIL'],
      }),
      { abortSignal: AbortSignal.timeout(this.timeoutMs) },
    );
    const sub = result.User?.Attributes?.find((a) => a.Name === 'sub')?.Value;
    if (!sub) throw new Error('IDENTITY_PROVIDER_MISSING_SUB');
    return { sub };
  }
  async find(username: string): Promise<{ sub: string } | null> {
    try {
      const result = await this.client.send(
        new AdminGetUserCommand({ UserPoolId: this.userPoolId, Username: username }),
        { abortSignal: AbortSignal.timeout(this.timeoutMs) },
      );
      const sub = result.UserAttributes?.find((a) => a.Name === 'sub')?.Value;
      if (!sub) throw new Error('IDENTITY_PROVIDER_MISSING_SUB');
      return { sub };
    } catch (error: unknown) {
      if (error instanceof Error && error.name === 'UserNotFoundException') return null;
      throw error;
    }
  }
  async addToGroup(username: string, group: Role): Promise<void> {
    await this.client.send(
      new AdminAddUserToGroupCommand({
        UserPoolId: this.userPoolId,
        Username: username,
        GroupName: group,
      }),
      { abortSignal: AbortSignal.timeout(this.timeoutMs) },
    );
  }
  async removeFromGroup(username: string, group: Role): Promise<void> {
    await this.client.send(
      new AdminRemoveUserFromGroupCommand({
        UserPoolId: this.userPoolId,
        Username: username,
        GroupName: group,
      }),
      { abortSignal: AbortSignal.timeout(this.timeoutMs) },
    );
  }
  async enable(username: string): Promise<void> {
    await this.client.send(
      new AdminEnableUserCommand({ UserPoolId: this.userPoolId, Username: username }),
      { abortSignal: AbortSignal.timeout(this.timeoutMs) },
    );
  }
  async delete(username: string): Promise<void> {
    try {
      await this.client.send(
        new AdminDeleteUserCommand({ UserPoolId: this.userPoolId, Username: username }),
        { abortSignal: AbortSignal.timeout(this.timeoutMs) },
      );
    } catch (error: unknown) {
      if (!(error instanceof Error && error.name === 'UserNotFoundException')) throw error;
    }
  }
  async disable(username: string): Promise<void> {
    await this.client.send(
      new AdminDisableUserCommand({ UserPoolId: this.userPoolId, Username: username }),
      { abortSignal: AbortSignal.timeout(this.timeoutMs) },
    );
  }
  async forcePasswordReset(username: string): Promise<void> {
    await this.client.send(
      new AdminResetUserPasswordCommand({ UserPoolId: this.userPoolId, Username: username }),
      { abortSignal: AbortSignal.timeout(this.timeoutMs) },
    );
  }
}
