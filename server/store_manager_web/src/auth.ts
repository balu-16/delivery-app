export type Tokens = { accessToken: string; refreshToken: string; expiresAt: number };
export type Challenge = { session: string; username: string; required: string[] };
type CognitoResult = {
  AuthenticationResult?: { AccessToken?: string; RefreshToken?: string; ExpiresIn?: number };
  ChallengeName?: string;
  ChallengeParameters?: Record<string, string>;
  Session?: string;
};

const region = import.meta.env.VITE_COGNITO_REGION as string | undefined;
const clientId = import.meta.env.VITE_COGNITO_CLIENT_ID as string | undefined;
const messages: Record<string, string> = {
  NotAuthorizedException: 'The email or password is incorrect.',
  UserNotFoundException: 'The email or password is incorrect.',
  UserNotConfirmedException: 'Verify your email before signing in.',
  PasswordResetRequiredException: 'Reset your password before signing in.',
  InvalidPasswordException: 'The password does not meet the account requirements.',
  CodeMismatchException: 'The verification code is incorrect.',
  ExpiredCodeException: 'The verification code has expired. Request another one.',
  LimitExceededException: 'Too many attempts. Please try again later.',
  TooManyRequestsException: 'Too many attempts. Please try again later.',
};

async function cognito<T>(operation: string, body: Record<string, unknown>): Promise<T> {
  if (
    !region ||
    !/^[a-z]{2}(?:-gov)?-[a-z]+-\d$/.test(region) ||
    !clientId ||
    !/^[a-zA-Z0-9]+$/.test(clientId)
  )
    throw new Error('Store sign-in is not configured. Contact your administrator.');
  let response: Response;
  try {
    response = await fetch(`https://cognito-idp.${region}.amazonaws.com/`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-amz-json-1.0',
        'X-Amz-Target': `AWSCognitoIdentityProviderService.${operation}`,
      },
      body: JSON.stringify(operation === 'GlobalSignOut' ? body : { ClientId: clientId, ...body }),
    });
  } catch {
    throw new Error('Cannot reach the sign-in service. Check your connection.');
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const name =
      String(data.__type ?? '')
        .split('#')
        .pop()
        ?.split(':')[0] ?? '';
    throw new Error(messages[name] ?? 'Sign-in could not be completed. Please try again.');
  }
  return data as T;
}

function outcome(
  result: CognitoResult,
  username: string,
  existingRefresh?: string,
): Tokens | Challenge {
  const tokens = result.AuthenticationResult;
  const refreshToken = tokens?.RefreshToken ?? existingRefresh;
  if (tokens?.AccessToken && refreshToken)
    return {
      accessToken: tokens.AccessToken,
      refreshToken,
      expiresAt: Date.now() + (tokens.ExpiresIn ?? 3600) * 1000,
    };
  if (result.ChallengeName === 'NEW_PASSWORD_REQUIRED' && result.Session) {
    let required: unknown;
    try {
      required = JSON.parse(result.ChallengeParameters?.requiredAttributes ?? '[]');
    } catch {
      throw new Error('This sign-in challenge is not supported.');
    }
    if (
      !Array.isArray(required) ||
      required.some(
        (item) =>
          typeof item !== 'string' ||
          !['name', 'email', 'phone_number'].includes(item.replace(/^userAttributes\./, '')),
      )
    )
      throw new Error('This sign-in challenge needs help from your administrator.');
    return {
      session: result.Session,
      username,
      required: required.map((item: string) => item.replace(/^userAttributes\./, '')),
    };
  }
  throw new Error('This sign-in challenge is not supported. Contact your administrator.');
}

export async function signIn(username: string, password: string): Promise<Tokens | Challenge> {
  let result = await cognito<CognitoResult>('InitiateAuth', {
    AuthFlow: 'USER_AUTH',
    AuthParameters: { USERNAME: username, PREFERRED_CHALLENGE: 'PASSWORD', PASSWORD: password },
  });
  if (result.ChallengeName === 'PASSWORD' && result.Session)
    result = await cognito<CognitoResult>('RespondToAuthChallenge', {
      ChallengeName: 'PASSWORD',
      Session: result.Session,
      ChallengeResponses: { USERNAME: username, PASSWORD: password },
    });
  return outcome(result, username);
}

export async function changeTemporaryPassword(
  challenge: Challenge,
  password: string,
  attributes: Record<string, string>,
): Promise<Tokens> {
  const values: Record<string, string> = { USERNAME: challenge.username, NEW_PASSWORD: password };
  for (const key of challenge.required) {
    if (!attributes[key]?.trim()) throw new Error(`Enter your ${key.replace('_', ' ')}.`);
    values[`userAttributes.${key}`] = attributes[key]!.trim();
  }
  const result = outcome(
    await cognito<CognitoResult>('RespondToAuthChallenge', {
      ChallengeName: 'NEW_PASSWORD_REQUIRED',
      Session: challenge.session,
      ChallengeResponses: values,
    }),
    challenge.username,
  );
  if ('session' in result) throw new Error('Please sign in again.');
  return result;
}

export async function refreshSession(tokens: Tokens): Promise<Tokens> {
  const result = outcome(
    await cognito<CognitoResult>('InitiateAuth', {
      AuthFlow: 'REFRESH_TOKEN_AUTH',
      AuthParameters: { REFRESH_TOKEN: tokens.refreshToken },
    }),
    '',
    tokens.refreshToken,
  );
  if ('session' in result) throw new Error('Please sign in again.');
  return result;
}
export async function signOut(tokens: Tokens): Promise<void> {
  await cognito('GlobalSignOut', { AccessToken: tokens.accessToken });
}
export async function forgotPassword(username: string): Promise<void> {
  await cognito('ForgotPassword', { Username: username });
}
export async function resetPassword(
  username: string,
  code: string,
  password: string,
): Promise<void> {
  await cognito('ConfirmForgotPassword', {
    Username: username,
    ConfirmationCode: code,
    Password: password,
  });
}
