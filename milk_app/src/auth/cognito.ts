type Operation = 'InitiateAuth' | 'RespondToAuthChallenge' | 'SignUp' | 'ConfirmSignUp' | 'ResendConfirmationCode' | 'ForgotPassword' | 'ConfirmForgotPassword' | 'GlobalSignOut';
export type AuthResult = { AuthenticationResult?: { IdToken?: string; AccessToken?: string; RefreshToken?: string; ExpiresIn?: number }; ChallengeName?: string; Session?: string };

/** Cognito public-client operations require no AWS credentials or client secret. */
export async function cognitoRequest<T>(operation: Operation, body: Record<string, unknown>): Promise<T> {
  const region = process.env.EXPO_PUBLIC_COGNITO_REGION;
  const clientId = process.env.EXPO_PUBLIC_COGNITO_CLIENT_ID;
  if (!region || !/^[a-z]{2}(?:-gov)?-[a-z]+-\d$/.test(region) || !clientId || !/^[a-zA-Z0-9]+$/.test(clientId)) {
    throw new Error('Set the public Cognito region and app client ID.');
  }
  const response = await fetch(`https://cognito-idp.${region}.amazonaws.com/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-amz-json-1.0', 'X-Amz-Target': `AWSCognitoIdentityProviderService.${operation}` },
    body: JSON.stringify(operation === 'GlobalSignOut' ? body : { ClientId: clientId, ...body }),
  });
  if (!response.ok) {
    // Do not display or log provider responses which can include account details.
    throw new Error('Could not complete authentication. Please check your details and try again.');
  }
  return await response.json() as T;
}
