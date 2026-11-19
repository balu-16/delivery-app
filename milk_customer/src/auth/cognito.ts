type Operation = 'InitiateAuth' | 'RespondToAuthChallenge' | 'SignUp' | 'ConfirmSignUp' | 'ResendConfirmationCode' | 'ForgotPassword' | 'ConfirmForgotPassword' | 'GlobalSignOut';

export type AuthResult = {
  AuthenticationResult?: { IdToken?: string; AccessToken?: string; RefreshToken?: string; ExpiresIn?: number };
  ChallengeName?: string;
  ChallengeParameters?: Record<string, string>;
  Session?: string;
};

export type AuthErrorCode =
  | 'INVALID_CREDENTIALS' | 'EMAIL_NOT_VERIFIED' | 'ACCOUNT_EXISTS' | 'INVALID_PASSWORD'
  | 'INVALID_CODE' | 'EXPIRED_CODE' | 'RATE_LIMITED' | 'RESET_REQUIRED' | 'INVALID_INPUT'
  | 'COGNITO_UNAVAILABLE' | 'COGNITO_UNREACHABLE' | 'AUTH_CONFIGURATION'
  | 'BACKEND_UNREACHABLE' | 'BACKEND_CONFIGURATION' | 'BACKEND_DISCOVERY' | 'UNSUPPORTED_CHALLENGE'
  | 'CHALLENGE_EXPIRED' | 'MISSING_ATTRIBUTE' | 'GROUP_PENDING' | 'UNKNOWN';

const messages: Record<AuthErrorCode, string> = {
  INVALID_CREDENTIALS: 'Email or password is incorrect.',
  EMAIL_NOT_VERIFIED: 'Verify your email before signing in.',
  ACCOUNT_EXISTS: 'An account already exists for this email.',
  INVALID_PASSWORD: 'This password does not meet the account requirements.',
  INVALID_CODE: 'That code is incorrect.',
  EXPIRED_CODE: 'Request a new verification code.',
  RATE_LIMITED: 'Too many attempts. Wait a few minutes and try again.',
  RESET_REQUIRED: 'A password reset is required for this account.',
  INVALID_INPUT: 'Some details are not valid.',
  COGNITO_UNAVAILABLE: 'The sign-in service is unavailable right now.',
  COGNITO_UNREACHABLE: 'Cannot reach the sign-in service.',
  AUTH_CONFIGURATION: 'Sign-in is not available right now.',
  BACKEND_UNREACHABLE: 'Cannot reach the customer server.',
  BACKEND_CONFIGURATION: 'Sign-in is not available right now.',
  BACKEND_DISCOVERY: 'Cannot find the customer server.',
  UNSUPPORTED_CHALLENGE: 'This account needs extra verification.',
  CHALLENGE_EXPIRED: 'Sign in again to continue.',
  MISSING_ATTRIBUTE: 'Fill in the required account details.',
  GROUP_PENDING: 'Your account is still being set up.',
  UNKNOWN: 'Couldn’t complete your request.',
};

export class AuthError extends Error {
  constructor(public readonly code: AuthErrorCode) {
    super(messages[code]);
    this.name = 'AuthError';
  }
}

const providerCodes: Record<string, AuthErrorCode> = {
  NotAuthorizedException: 'INVALID_CREDENTIALS',
  UserNotFoundException: 'INVALID_CREDENTIALS',
  UserNotConfirmedException: 'EMAIL_NOT_VERIFIED',
  UsernameExistsException: 'ACCOUNT_EXISTS',
  InvalidPasswordException: 'INVALID_PASSWORD',
  CodeMismatchException: 'INVALID_CODE',
  ExpiredCodeException: 'EXPIRED_CODE',
  TooManyRequestsException: 'RATE_LIMITED',
  TooManyFailedAttemptsException: 'RATE_LIMITED',
  LimitExceededException: 'RATE_LIMITED',
  PasswordResetRequiredException: 'RESET_REQUIRED',
  InvalidParameterException: 'INVALID_INPUT',
};

/** Cognito public-client operations require no AWS credentials or client secret. */
export async function cognitoRequest<T>(operation: Operation, body: Record<string, unknown>): Promise<T> {
  const region = process.env.EXPO_PUBLIC_COGNITO_REGION;
  const clientId = process.env.EXPO_PUBLIC_COGNITO_CLIENT_ID;
  if (!region || !/^[a-z]{2}(?:-gov)?-[a-z]+-\d$/.test(region) || !clientId || !/^[a-zA-Z0-9]+$/.test(clientId)) {
    throw new AuthError('AUTH_CONFIGURATION');
  }
  let response: Response;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  try {
    response = await fetch(`https://cognito-idp.${region}.amazonaws.com/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-amz-json-1.0', 'X-Amz-Target': `AWSCognitoIdentityProviderService.${operation}` },
      body: JSON.stringify(operation === 'GlobalSignOut' ? body : { ClientId: clientId, ...body }),
      signal: controller.signal,
    });
  } catch {
    throw new AuthError('COGNITO_UNREACHABLE');
  } finally {
    clearTimeout(timeout);
  }
  if (!response.ok) {
    // Only use an allowlisted error type. Provider messages can contain private details.
    const data = await response.json().catch(() => null) as { __type?: unknown; code?: unknown } | null;
    const raw = typeof data?.__type === 'string' ? data.__type : typeof data?.code === 'string' ? data.code : response.headers.get('x-amzn-errortype') ?? '';
    const name = raw.split('#').pop()?.split(':')[0] ?? '';
    let mapped = Object.prototype.hasOwnProperty.call(providerCodes, name) ? providerCodes[name] : undefined;
    if ((name === 'UserNotFoundException' || name === 'NotAuthorizedException') && !['InitiateAuth', 'RespondToAuthChallenge'].includes(operation)) mapped = 'INVALID_INPUT';
    throw new AuthError(mapped ?? (response.status === 429 ? 'RATE_LIMITED' : response.status >= 500 ? 'COGNITO_UNAVAILABLE' : 'UNKNOWN'));
  }
  try {
    return await response.json() as T;
  } catch {
    throw new AuthError('COGNITO_UNAVAILABLE');
  }
}
