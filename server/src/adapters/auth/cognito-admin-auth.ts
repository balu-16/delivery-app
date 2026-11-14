import {
  AdminInitiateAuthCommand,
  AdminRespondToAuthChallengeCommand,
  CognitoIdentityProviderClient,
  ConfirmForgotPasswordCommand,
  ForgotPasswordCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import {
  AdminAuthProviderError,
  type AdminAuthenticated,
  type AdminLoginOutcome,
  type AdminPortalAuthProvider,
  type AuthTokens,
} from '../../modules/identity/contracts/admin-auth.js';

const TIMEOUT_MS_DEFAULT = 3000;

/**
 * Workforce-pool admin portal authentication (P14). Uses the ADMIN_* server
 * flows against COGNITO_ADMIN_CLIENT_ID; password resets use the provider's
 * ForgotPassword/ConfirmForgotPassword with the pool's configured delivery.
 * Every failure is mapped to the bounded contract union before it leaves the
 * adapter, so responses cannot reveal which factor was wrong or leak vendor
 * messages.
 */
export class CognitoAdminAuth implements AdminPortalAuthProvider {
  constructor(
    private readonly client: CognitoIdentityProviderClient,
    private readonly userPoolId: string,
    private readonly clientId: string,
    private readonly timeoutMs = TIMEOUT_MS_DEFAULT,
  ) {}

  async passwordLogin(email: string, password: string): Promise<AdminLoginOutcome> {
    let result;
    try {
      result = await this.client.send(
        new AdminInitiateAuthCommand({
          UserPoolId: this.userPoolId,
          ClientId: this.clientId,
          AuthFlow: 'ADMIN_USER_PASSWORD_AUTH',
          AuthParameters: { USERNAME: email, PASSWORD: password },
        }),
        { abortSignal: AbortSignal.timeout(this.timeoutMs) },
      );
    } catch (error: unknown) {
      throw this.map(error, false);
    }
    if (result.ChallengeName === 'NEW_PASSWORD_REQUIRED')
      return {
        status: 'CHALLENGE',
        challenge: 'NEW_PASSWORD_REQUIRED',
        providerSession: requireSession(result.Session),
      };
    const tokens = authTokens(result.AuthenticationResult);
    if (!tokens) throw new AdminAuthProviderError('provider_unavailable');
    return { status: 'AUTHENTICATED', tokens };
  }

  async respondToChallenge(
    providerSession: string,
    newPassword: string,
  ): Promise<AdminAuthenticated> {
    try {
      const result = await this.client.send(
        new AdminRespondToAuthChallengeCommand({
          UserPoolId: this.userPoolId,
          ClientId: this.clientId,
          ChallengeName: 'NEW_PASSWORD_REQUIRED',
          Session: providerSession,
          ChallengeResponses: { NEW_PASSWORD: newPassword },
        }),
        { abortSignal: AbortSignal.timeout(this.timeoutMs) },
      );
      const tokens = authTokens(result.AuthenticationResult);
      if (!tokens) throw new AdminAuthProviderError('challenge_required');
      return { status: 'AUTHENTICATED', tokens };
    } catch (error: unknown) {
      throw this.map(error, true);
    }
  }

  async forgotPassword(email: string): Promise<void> {
    try {
      await this.client.send(
        new ForgotPasswordCommand({ ClientId: this.clientId, Username: email }),
        { abortSignal: AbortSignal.timeout(this.timeoutMs) },
      );
    } catch (error: unknown) {
      // Unknown accounts intentionally succeed upstream; only outages surface here.
      throw this.map(error, true);
    }
  }

  async confirmForgotPassword(
    email: string,
    confirmationCode: string,
    newPassword: string,
  ): Promise<void> {
    try {
      await this.client.send(
        new ConfirmForgotPasswordCommand({
          ClientId: this.clientId,
          Username: email,
          ConfirmationCode: confirmationCode,
          Password: newPassword,
        }),
        { abortSignal: AbortSignal.timeout(this.timeoutMs) },
      );
    } catch (error: unknown) {
      throw this.map(error, true);
    }
  }

  /**
   * Documented Cognito semantics: REFRESH_TOKEN_AUTH reuses the refresh token
   * and returns a new access token (refresh rotation is not enabled for this
   * client), so the stored refresh token never changes on rotation.
   */
  async refresh(refreshToken: string): Promise<AdminAuthenticated> {
    try {
      const result = await this.client.send(
        new AdminInitiateAuthCommand({
          UserPoolId: this.userPoolId,
          ClientId: this.clientId,
          AuthFlow: 'REFRESH_TOKEN_AUTH',
          AuthParameters: { REFRESH_TOKEN: refreshToken },
        }),
        { abortSignal: AbortSignal.timeout(this.timeoutMs) },
      );
      const tokens = authTokens(result.AuthenticationResult);
      if (!tokens) throw new AdminAuthProviderError('challenge_required');
      return { status: 'AUTHENTICATED', tokens };
    } catch (error: unknown) {
      throw this.map(error, true);
    }
  }

  private map(error: unknown, keepNotFound: boolean): AdminAuthProviderError {
    const name = error instanceof Error ? error.name : '';
    switch (name) {
      case 'NotAuthorizedException':
      case 'PasswordResetRequiredException':
        return new AdminAuthProviderError('invalid_credentials', error);
      case 'UserNotFoundException':
        return new AdminAuthProviderError(
          keepNotFound ? 'user_not_found' : 'invalid_credentials',
          error,
        );
      case 'ExpiredCodeException':
      case 'CodeMismatchException':
      case 'InvalidParameterException':
        return new AdminAuthProviderError('challenge_required', error);
      case 'InvalidPasswordException':
      case 'InvalidLambdaResponseException':
        return new AdminAuthProviderError('policy_violation', error);
      case 'TooManyRequestsException':
      case 'TooManyFailedAttemptsException':
      case 'ThrottlingException':
      case 'LimitExceededException':
        return new AdminAuthProviderError('provider_unavailable', error);
      default: {
        const status =
          typeof error === 'object' && error !== null && '$metadata' in error
            ? (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode
            : undefined;
        if (typeof status === 'number' && status >= 500)
          return new AdminAuthProviderError('provider_unavailable', error);
        if (name === 'AbortError' || name === 'TimeoutError')
          return new AdminAuthProviderError('provider_unavailable', error);
        return new AdminAuthProviderError('provider_unavailable', error);
      }
    }
  }
}

function requireSession(session: string | undefined): string {
  if (!session) throw new AdminAuthProviderError('provider_unavailable');
  return session;
}

function authTokens(
  result:
    | {
        AccessToken?: string;
        RefreshToken?: string;
        ExpiresIn?: number;
      }
    | undefined,
): AuthTokens | null {
  if (!result?.AccessToken || !result.RefreshToken || typeof result.ExpiresIn !== 'number')
    return null;
  return {
    accessToken: result.AccessToken,
    refreshToken: result.RefreshToken,
    expiresIn: result.ExpiresIn,
  };
}
