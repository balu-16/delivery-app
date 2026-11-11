import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { cognitoRequest, type AuthResult } from './cognito';
import { customerApi } from '../api/customer';
import { customerRequest } from '../api/client';

const SESSION_KEY = 'dairydirect.customer.session.v1';
const referralKey = (email:string) => `@dairydirect/signup-referral-v1:${encodeURIComponent(email.trim().toLowerCase())}`;
type Session = { mode: 'local' | 'cognito'; accessToken: string; refreshToken?: string; expiresAt: number; localSubject?: string };
let current: Session | null = null;
let refreshInFlight: Promise<string> | null = null;
let sessionGeneration = 0;
let storageQueue: Promise<void> = Promise.resolve();

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
export async function login(email: string, password: string, referralCode?: string | null) {
  const generation = ++sessionGeneration;
  if (mode() !== 'cognito') throw new Error('Email sign-in requires Cognito.');
  const username = email.trim();
  const result = await cognitoRequest<AuthResult>('InitiateAuth', { AuthFlow: 'USER_AUTH', AuthParameters: { USERNAME: username, PREFERRED_CHALLENGE: 'PASSWORD', PASSWORD: password } });
  let tokens = result.AuthenticationResult;
  if (!tokens && result.ChallengeName === 'PASSWORD' && result.Session) {
    const challenge = await cognitoRequest<AuthResult>('RespondToAuthChallenge', { ChallengeName: 'PASSWORD', Session: result.Session, ChallengeResponses: { USERNAME: username, PASSWORD: password } });
    tokens = challenge.AuthenticationResult;
  }
  if (!tokens?.IdToken || !tokens.AccessToken || !tokens.RefreshToken) throw new Error('Additional sign-in verification is required.');
  const code = referralCode === null ? undefined : (referralCode?.trim().toUpperCase() || await AsyncStorage.getItem(referralKey(username)) || undefined);
  if (code && !/^[A-F0-9]{16}$/.test(code)) throw new Error('Enter a valid 16-character referral code.');
  await customerApi.bootstrap(tokens.IdToken, code);
  if (generation !== sessionGeneration) throw new Error('Session changed.');
  await save({ mode: 'cognito', accessToken: tokens.AccessToken, refreshToken: tokens.RefreshToken, expiresAt: Date.now() + (tokens.ExpiresIn ?? 3600) * 1000 });
  await AsyncStorage.removeItem(referralKey(username)).catch(() => {});
}
export async function signUp(email: string, password: string, name: string, referralCode?:string) {
  if (mode() !== 'cognito') throw new Error('Registration is not available for local test accounts.');
  const code = referralCode?.trim().toUpperCase();
  if (code && !/^[A-F0-9]{16}$/.test(code)) throw new Error('Enter a valid 16-character referral code.');
  if (code) await AsyncStorage.setItem(referralKey(email),code);
  else await AsyncStorage.removeItem(referralKey(email));
  await cognitoRequest('SignUp', { Username: email.trim(), Password: password, UserAttributes: [{ Name: 'email', Value: email.trim() }, { Name: 'name', Value: name.trim() }] });
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
