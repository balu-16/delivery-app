import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { AuthError, cognitoRequest, type AuthResult } from './cognito';
import { customerApi } from '../api/customer';
import { ApiError, customerRequest } from '../api/client';

const SESSION_KEY = 'dairydirect.customer.session.v1';
const referralKey = (email:string) => `@dairydirect/signup-referral-v1:${encodeURIComponent(email.trim().toLowerCase())}`;
type Session = { mode: 'local' | 'cognito'; accessToken: string; refreshToken?: string; expiresAt: number; localSubject?: string };
let current: Session | null = null;
let refreshInFlight: Promise<string> | null = null;
let sessionGeneration = 0;
let storageQueue: Promise<void> = Promise.resolve();
export type RequiredAttribute = 'name' | 'email' | 'phone_number';
type PendingPasswordChange = { username: string; session: string; generation: number; referralCode?: string | null; required: RequiredAttribute[] };
let pendingPasswordChange: PendingPasswordChange | null = null;

export type LoginResult = { kind: 'signedIn' } | { kind: 'newPasswordRequired'; requiredAttributes: RequiredAttribute[] };

/** A successful password change must not be repeated if the following bootstrap fails. */
export class PasswordChangedError extends Error {
  constructor(public readonly original: unknown) {
    super('Password updated. Sign in with your new password to continue.');
    this.name = 'PasswordChangedError';
  }
}
export class PasswordChangeUncertainError extends Error {
  constructor() {
    super('We could not confirm whether your password changed. Try signing in with your new password; if it does not work, use your temporary password or reset it.');
    this.name = 'PasswordChangeUncertainError';
  }
}

function requiredAttributes(result: AuthResult): RequiredAttribute[] {
  const raw = result.ChallengeParameters?.requiredAttributes;
  if (!raw) return [];
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new AuthError('UNSUPPORTED_CHALLENGE'); }
  if (!Array.isArray(parsed) || parsed.length > 3) throw new AuthError('UNSUPPORTED_CHALLENGE');
  const supported: RequiredAttribute[] = [];
  for (const item of parsed) {
    if (typeof item !== 'string') throw new AuthError('UNSUPPORTED_CHALLENGE');
    const name = item.replace(/^userAttributes\./, '');
    if (name !== 'name' && name !== 'email' && name !== 'phone_number') throw new AuthError('UNSUPPORTED_CHALLENGE');
    if (!supported.includes(name)) supported.push(name);
  }
  return supported;
}

export function cancelPasswordChange() { pendingPasswordChange = null; }

function mode() {
  const value = process.env.EXPO_PUBLIC_AUTH_MODE;
  if (value === 'local' && __DEV__) return 'local';
  if (value === 'cognito') return 'cognito';
  throw new Error('Configure EXPO_PUBLIC_AUTH_MODE as cognito or local (development only).');
}
async function save(session: Session | null) {
  current = session;
  // Web uses memory only. Never store bearer tokens in browser localStorage.
  if (Platform.OS !== 'web') {
    storageQueue = storageQueue.catch(() => {}).then(async () => {
      if (session) await SecureStore.setItemAsync(SESSION_KEY, JSON.stringify(session));
      else await SecureStore.deleteItemAsync(SESSION_KEY);
    });
    await storageQueue;
  }
}
export async function restoreSession(): Promise<boolean> {
  if (Platform.OS === 'web') return !!current;
  await storageQueue.catch(() => {});
  let raw: string | null;
  try {
    raw = await SecureStore.getItemAsync(SESSION_KEY);
    if (!raw) return false;
    const session: Session = JSON.parse(raw);
    if (!session.accessToken || !Number.isFinite(session.expiresAt) || session.mode !== mode()) throw new Error('Invalid session');
    current = session;
  } catch {
    await save(null);
    return false;
  }
  // A temporary network failure must not erase a valid stored session.
  await accessToken();
  return true;
}
async function localTokens(subject: string) {
  if (mode() !== 'local') throw new Error('Local login unavailable.');
  const issue = (tokenUse: 'id' | 'access') => customerRequest<{ token: string }>('/dev/auth/token', {
    method: 'POST', body: { pool: 'CUSTOMER', sub: subject, audience: 'customer', tokenUse },
  });
  const id = await issue('id');
  await customerApi.bootstrap(id.token);
  const access = await issue('access');
  return { token: access.token, expiresAt: Date.now() + 50 * 60 * 1000 };
}
export async function loginLocal(subject = 'customer') {
  const generation = ++sessionGeneration;
  const result = await localTokens(subject);
  if (generation !== sessionGeneration) throw new Error('Session changed.');
  await save({ mode: 'local', localSubject: subject, accessToken: result.token, expiresAt: result.expiresAt });
}
async function finishCognitoLogin(tokens: AuthResult['AuthenticationResult'], username: string, generation: number, referralCode?: string | null): Promise<void> {
  if (!tokens?.IdToken || !tokens.AccessToken || !tokens.RefreshToken) throw new AuthError('UNSUPPORTED_CHALLENGE');
  const code = referralCode === null ? undefined : (referralCode?.trim().toUpperCase() || await AsyncStorage.getItem(referralKey(username)) || undefined);
  if (code && !/^[A-F0-9]{16}$/.test(code)) throw new Error('Enter a valid 16-character referral code.');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
  try {
    await customerApi.bootstrap(tokens.IdToken, code, controller.signal);
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (error instanceof Error && error.message.includes('EXPO_PUBLIC_API_URL')) throw new AuthError('BACKEND_CONFIGURATION');
    throw new AuthError('BACKEND_UNREACHABLE');
  } finally {
    clearTimeout(timeout);
  }
  if (generation !== sessionGeneration) throw new Error('Session changed.');
  await save({ mode: 'cognito', accessToken: tokens.AccessToken, refreshToken: tokens.RefreshToken, expiresAt: Date.now() + (tokens.ExpiresIn ?? 3600) * 1000 });
  await AsyncStorage.removeItem(referralKey(username)).catch(() => {});
}

export async function login(email: string, password: string, referralCode?: string | null): Promise<LoginResult> {
  const generation = ++sessionGeneration;
  pendingPasswordChange = null;
  if (mode() !== 'cognito') throw new Error('Email sign-in requires Cognito.');
  const username = email.trim();
  let result = await cognitoRequest<AuthResult>('InitiateAuth', { AuthFlow: 'USER_AUTH', AuthParameters: { USERNAME: username, PREFERRED_CHALLENGE: 'PASSWORD', PASSWORD: password } });
  if (!result.AuthenticationResult && result.ChallengeName === 'PASSWORD' && result.Session) {
    result = await cognitoRequest<AuthResult>('RespondToAuthChallenge', { ChallengeName: 'PASSWORD', Session: result.Session, ChallengeResponses: { USERNAME: username, PASSWORD: password } });
  }
  if (generation !== sessionGeneration) throw new Error('Session changed.');
  if (result.ChallengeName === 'NEW_PASSWORD_REQUIRED' && result.Session) {
    const required = requiredAttributes(result);
    pendingPasswordChange = { username, session: result.Session, generation, referralCode, required };
    return { kind: 'newPasswordRequired', requiredAttributes: required };
  }
  await finishCognitoLogin(result.AuthenticationResult, username, generation, referralCode);
  return { kind: 'signedIn' };
}

export async function completePasswordChange(password: string, attributes: Partial<Record<RequiredAttribute, string>>): Promise<void> {
  const challenge = pendingPasswordChange;
  if (!challenge || challenge.generation !== sessionGeneration) throw new AuthError('CHALLENGE_EXPIRED');
  const values: Record<string, string> = { USERNAME: challenge.username, NEW_PASSWORD: password };
  for (const attribute of challenge.required) {
    const value = attributes[attribute]?.trim();
    if (!value) throw new AuthError('MISSING_ATTRIBUTE');
    values[`userAttributes.${attribute}`] = value;
  }
  let result: AuthResult;
  try {
    result = await cognitoRequest<AuthResult>('RespondToAuthChallenge', { ChallengeName: 'NEW_PASSWORD_REQUIRED', Session: challenge.session, ChallengeResponses: values });
  } catch (error) {
    if (error instanceof AuthError && ['COGNITO_UNREACHABLE', 'COGNITO_UNAVAILABLE'].includes(error.code)) {
      pendingPasswordChange = null;
      throw new PasswordChangeUncertainError();
    }
    if (error instanceof AuthError && error.code === 'INVALID_CREDENTIALS') {
      pendingPasswordChange = null;
      throw new AuthError('CHALLENGE_EXPIRED');
    }
    throw error;
  }
  // Cognito has consumed the challenge; never try to submit the new password twice.
  pendingPasswordChange = null;
  if (!result.AuthenticationResult) throw new PasswordChangedError(new AuthError('UNSUPPORTED_CHALLENGE'));
  try {
    await finishCognitoLogin(result.AuthenticationResult, challenge.username, challenge.generation, challenge.referralCode);
  } catch (error) {
    throw new PasswordChangedError(error);
  }
}
export async function signUp(email: string, password: string, name: string, referralCode?:string) {
  if (mode() !== 'cognito') throw new Error('Registration is not available for local test accounts.');
  const code = referralCode?.trim().toUpperCase();
  if (code && !/^[A-F0-9]{16}$/.test(code)) throw new Error('Enter a valid 16-character referral code.');
  const key = referralKey(email);
  const previous = await AsyncStorage.getItem(key);
  if (code) await AsyncStorage.setItem(key, code);
  else await AsyncStorage.removeItem(key);
  try {
    const result = await cognitoRequest<{ UserConfirmed?: boolean }>('SignUp', { Username: email.trim(), Password: password, UserAttributes: [{ Name: 'email', Value: email.trim() }, { Name: 'name', Value: name.trim() }] });
    return { confirmed: result.UserConfirmed === true };
  } catch (error) {
    // A lost response may follow a successful signup, so keep its referral for the later bootstrap.
    if (!(error instanceof AuthError && ['COGNITO_UNREACHABLE', 'COGNITO_UNAVAILABLE'].includes(error.code))) {
      if (previous) await AsyncStorage.setItem(key, previous).catch(() => {});
      else await AsyncStorage.removeItem(key).catch(() => {});
    }
    throw error;
  }
}
export async function confirmSignUp(email: string, code: string) {
  await cognitoRequest('ConfirmSignUp', { Username: email.trim(), ConfirmationCode: code.trim() });
}
export async function resendSignUpCode(email: string) {
  await cognitoRequest('ResendConfirmationCode', { Username: email.trim() });
}
export async function requestPasswordReset(email: string) {
  await cognitoRequest('ForgotPassword', { Username: email.trim() });
}
export async function confirmPasswordReset(email: string, code: string, password: string) {
  await cognitoRequest('ConfirmForgotPassword', { Username: email.trim(), ConfirmationCode: code.trim(), Password: password });
}
export async function accessToken(): Promise<string> {
  if (!current) throw new Error('Sign in to continue.');
  if (Date.now() < current.expiresAt - 60_000) return current.accessToken;
  if (refreshInFlight) return refreshInFlight;
  const previous = current;
  refreshInFlight = (async () => {
    if (previous.mode === 'local') {
      const result = await localTokens(previous.localSubject ?? 'customer');
      if (current !== previous) throw new Error('Session changed.');
      await save({ ...previous, accessToken: result.token, expiresAt: result.expiresAt });
      return result.token;
    }
    if (!previous.refreshToken) throw new Error('Sign in again.');
    const result = await cognitoRequest<AuthResult>('InitiateAuth', { AuthFlow: 'REFRESH_TOKEN_AUTH', AuthParameters: { REFRESH_TOKEN: previous.refreshToken } });
    const tokens = result.AuthenticationResult;
    if (!tokens?.AccessToken) throw new Error('Sign in again.');
    if (current !== previous) throw new Error('Session changed.');
    await save({ ...previous, accessToken: tokens.AccessToken, refreshToken: tokens.RefreshToken ?? previous.refreshToken, expiresAt: Date.now() + (tokens.ExpiresIn ?? 3600) * 1000 });
    return tokens.AccessToken;
  })().finally(() => { refreshInFlight = null; });
  return refreshInFlight;
}
export async function signOut() {
  sessionGeneration++;
  pendingPasswordChange = null;
  const previous = current;
  // Clear immediately so an in-flight refresh cannot restore a signed-out session.
  current = null;
  let storageError: unknown;
  try { await save(null); } catch (error) { storageError = error; }
  if (previous?.mode === 'cognito') {
    try { await cognitoRequest('GlobalSignOut', { AccessToken: previous.accessToken }); } catch { /* Always clear the local session. */ }
  }
  if (storageError) throw new Error('Could not securely remove the saved session. Please try signing out again.');
}
