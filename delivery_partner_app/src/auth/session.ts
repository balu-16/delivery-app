import { Platform } from "react-native";
import * as SecureStore from "expo-secure-store";
import { AuthError, cognitoRequest, type AuthResult } from "./cognito";
import { withSessionLock } from './sessionLock';

const REFRESH_KEY = "dairydirect.partner.refresh.v1";
export type PartnerIdentity = { subject: string; email: string; name: string };
type Session = {
  identity: PartnerIdentity;
  accessToken: string;
  idToken?: string;
  refreshToken: string;
  expiresAt: number;
};
type PendingChange = {
  username: string;
  session: string;
  generation: number;
  required: string[];
};
export type LoginResult =
  | { kind: "signedIn"; identity: PartnerIdentity }
  | { kind: "newPassword"; required: string[] };
export class PasswordChangeUncertainError extends Error {
  constructor() {
    super(
      "Your password may have changed. Try signing in with the new password, or reset it if needed.",
    );
  }
}
export class PasswordChangedError extends Error {
  constructor() {
    super(
      "Your password was updated. Sign in with the new password to continue.",
    );
  }
}
let current: Session | null = null;
let generation = 0;
let pendingChange: PendingChange | null = null;
let storageQueue: Promise<void> = Promise.resolve();
let refreshInFlight: Promise<PartnerIdentity> | null = null;
let restoreInFlight: Promise<PartnerIdentity | null> | null = null;

const secureOptions = Platform.OS === "ios"
  ? { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY }
  : undefined;

async function saveRefresh(value: string | null) {
  if (Platform.OS === "web") return;
  storageQueue = storageQueue
    .catch(() => {})
    .then(() =>
      value
        ? SecureStore.setItemAsync(REFRESH_KEY, value, secureOptions)
        : SecureStore.deleteItemAsync(REFRESH_KEY, secureOptions),
    );
  await storageQueue;
}

async function identityFor(accessToken: string): Promise<PartnerIdentity> {
  const result = await cognitoRequest<{
    Username?: string;
    UserAttributes?: { Name?: string; Value?: string }[];
  }>("GetUser", { AccessToken: accessToken });
  const attributes = Object.fromEntries(
    (result.UserAttributes ?? []).map((item) => [item.Name, item.Value]),
  );
  if (!attributes.sub) throw new AuthError("COGNITO_UNAVAILABLE");
  return {
    subject: attributes.sub,
    email: attributes.email ?? "",
    name: attributes.name?.trim() || "Partner",
  };
}

async function finish(
  result: AuthResult["AuthenticationResult"],
  version: number,
  previousRefresh?: string,
): Promise<PartnerIdentity> {
  const accessToken = result?.AccessToken;
  const refreshToken = result?.RefreshToken ?? previousRefresh;
  if (!accessToken || !refreshToken)
    throw new AuthError("UNSUPPORTED_CHALLENGE");
  if (version !== generation) {
    if (result?.RefreshToken)
      void cognitoRequest("RevokeToken", { Token: result.RefreshToken }).catch(
        () => {},
      );
    throw new Error("Session changed. Please sign in again.");
  }
  await saveRefresh(refreshToken);
  if (version !== generation) {
    if (result?.RefreshToken)
      void cognitoRequest("RevokeToken", { Token: result.RefreshToken }).catch(
        () => {},
      );
    throw new Error("Session changed. Please sign in again.");
  }
  // Keep a rotated refresh token even if the subsequent profile request fails.
  if (current && previousRefresh && current.refreshToken === previousRefresh)
    current = {
      ...current,
      refreshToken,
      accessToken,
      idToken: result?.IdToken,
      expiresAt: Date.now() + (result?.ExpiresIn ?? 3600) * 1000,
    };
  const identity = await identityFor(accessToken);
  if (version !== generation) {
    if (result?.RefreshToken)
      void cognitoRequest("RevokeToken", { Token: result.RefreshToken }).catch(
        () => {},
      );
    throw new Error("Session changed. Please sign in again.");
  }
  current = {
    identity,
    accessToken,
    idToken: result?.IdToken,
    refreshToken,
    expiresAt: Date.now() + (result?.ExpiresIn ?? 3600) * 1000,
  };
  return identity;
}

export async function signIn(
  email: string,
  password: string,
): Promise<LoginResult> {
  const version = ++generation;
  pendingChange = null;
  const username = email.trim();
  let result = await cognitoRequest<AuthResult>("InitiateAuth", {
    AuthFlow: "USER_AUTH",
    AuthParameters: {
      USERNAME: username,
      PREFERRED_CHALLENGE: "PASSWORD",
      PASSWORD: password,
    },
  });
  if (
    !result.AuthenticationResult &&
    result.ChallengeName === "PASSWORD" &&
    result.Session
  )
    result = await cognitoRequest<AuthResult>("RespondToAuthChallenge", {
      ChallengeName: "PASSWORD",
      Session: result.Session,
      ChallengeResponses: { USERNAME: username, PASSWORD: password },
    });
  if (version !== generation)
    throw new Error("Session changed. Please sign in again.");
  if (result.ChallengeName === "NEW_PASSWORD_REQUIRED" && result.Session) {
    let required: unknown = [];
    try {
      required = JSON.parse(
        result.ChallengeParameters?.requiredAttributes ?? "[]",
      );
    } catch {
      throw new AuthError("UNSUPPORTED_CHALLENGE");
    }
    if (
      !Array.isArray(required) ||
      required.some(
        (item) =>
          typeof item !== "string" ||
          !["name", "email", "phone_number"].includes(
            item.replace(/^userAttributes\./, ""),
          ),
      )
    )
      throw new AuthError("UNSUPPORTED_CHALLENGE");
    pendingChange = {
      username,
      session: result.Session,
      generation: version,
      required: required.map((item: string) =>
        item.replace(/^userAttributes\./, ""),
      ),
    };
    return { kind: "newPassword", required: pendingChange.required };
  }
  return {
    kind: "signedIn",
    identity: await withSessionLock(() => finish(result.AuthenticationResult, version)),
  };
}

export async function completeNewPassword(
  password: string,
  attributes: Record<string, string>,
) {
  const pending = pendingChange;
  if (!pending || pending.generation !== generation)
    throw new AuthError("CHALLENGE_EXPIRED");
  const responses: Record<string, string> = {
    USERNAME: pending.username,
    NEW_PASSWORD: password,
  };
  for (const name of pending.required) {
    const value = attributes[name]?.trim();
    if (!value) throw new AuthError("MISSING_ATTRIBUTE");
    responses[`userAttributes.${name}`] = value;
  }
  let result: AuthResult;
  try {
    result = await cognitoRequest<AuthResult>("RespondToAuthChallenge", {
      ChallengeName: "NEW_PASSWORD_REQUIRED",
      Session: pending.session,
      ChallengeResponses: responses,
    });
  } catch (error) {
    if (
      error instanceof AuthError &&
      ["COGNITO_UNREACHABLE", "COGNITO_UNAVAILABLE"].includes(error.code)
    ) {
      pendingChange = null;
      throw new PasswordChangeUncertainError();
    }
    throw error;
  }
  pendingChange = null;
  try {
    return await withSessionLock(() => finish(result.AuthenticationResult, pending.generation));
  } catch {
    throw new PasswordChangedError();
  }
}

export async function signUp(email: string, password: string, name: string) {
  return cognitoRequest<{ UserConfirmed?: boolean }>("SignUp", {
    Username: email.trim(),
    Password: password,
    UserAttributes: [
      { Name: "email", Value: email.trim() },
      { Name: "name", Value: name.trim() },
    ],
  });
}
export const confirmSignUp = (email: string, code: string) =>
  cognitoRequest("ConfirmSignUp", {
    Username: email.trim(),
    ConfirmationCode: code.trim(),
  });
export const resendCode = (email: string) =>
  cognitoRequest("ResendConfirmationCode", { Username: email.trim() });
export const forgotPassword = (email: string) =>
  cognitoRequest("ForgotPassword", { Username: email.trim() });
export const confirmPassword = (
  email: string,
  code: string,
  password: string,
) =>
  cognitoRequest("ConfirmForgotPassword", {
    Username: email.trim(),
    ConfirmationCode: code.trim(),
    Password: password,
  });

async function restoreSavedSession(): Promise<PartnerIdentity | null> {
  if (Platform.OS === "web") return current?.identity ?? null;
  const version = ++generation;
  return withSessionLock(async () => {
    await storageQueue.catch(() => {});
    const token = await SecureStore.getItemAsync(REFRESH_KEY, secureOptions);
    if (version !== generation) throw new Error("Session changed. Please sign in again.");
    if (!token) return null;
    try {
      const result = await cognitoRequest<AuthResult>("GetTokensFromRefreshToken", { RefreshToken: token });
      return await finish(result.AuthenticationResult, version, token);
    } catch (error) {
      if (version === generation && error instanceof AuthError && error.code === "INVALID_CREDENTIALS") {
        await saveRefresh(null);
        return null;
      }
      throw error;
    }
  });
}

export async function restoreSession(): Promise<PartnerIdentity | null> {
  if (current) return current.identity;
  if (!restoreInFlight) {
    restoreInFlight = restoreSavedSession().finally(() => { restoreInFlight = null; });
  }
  return restoreInFlight;
}

export async function refreshSession(force = false): Promise<PartnerIdentity> {
  if (!current) throw new Error("Sign in to continue.");
  if (refreshInFlight) return refreshInFlight;
  if (!force && Date.now() < current.expiresAt - 60_000) return current.identity;
  const previous = current;
  const version = generation;
  refreshInFlight = withSessionLock(async () => {
    const token = Platform.OS === 'web' ? previous.refreshToken : await SecureStore.getItemAsync(REFRESH_KEY, secureOptions);
    if (version !== generation || !token || !current) throw new Error('Session changed. Please sign in again.');
    if (current.refreshToken !== token) current = { ...current, refreshToken: token };
    const result = await cognitoRequest<AuthResult>('GetTokensFromRefreshToken', { RefreshToken: token });
    return finish(result.AuthenticationResult, version, token);
  })
    .finally(() => {
      refreshInFlight = null;
    });
  return refreshInFlight;
}

export async function getAccessToken(force = false): Promise<string> {
  if (!current && !(await restoreSession())) throw new Error("Sign in to continue.");
  await refreshSession(force);
  if (!current) throw new Error("Sign in to continue.");
  return current.accessToken;
}

export async function getSessionIdentity(): Promise<PartnerIdentity> {
  if (!current && !(await restoreSession())) throw new Error('Sign in to continue.');
  await refreshSession();
  if (!current) throw new Error('Sign in to continue.');
  return current.identity;
}

export async function getIdToken(): Promise<string> {
  if (!current && !(await restoreSession())) throw new Error("Sign in to continue.");
  await refreshSession();
  if (!current?.idToken) await refreshSession(true);
  if (!current?.idToken) throw new Error("The sign-in provider did not return an ID token.");
  return current.idToken;
}

export async function signOut() {
  generation++;
  pendingChange = null;
  const previous = current;
  current = null;
  const token = await withSessionLock(async () => {
    const saved = Platform.OS === 'web' ? null : await SecureStore.getItemAsync(REFRESH_KEY, secureOptions);
    await saveRefresh(null);
    return saved ?? previous?.refreshToken;
  });
  if (token)
    void cognitoRequest("RevokeToken", { Token: token }).catch(
      () => {},
    );
}
