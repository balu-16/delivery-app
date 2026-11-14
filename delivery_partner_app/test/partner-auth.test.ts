/// <reference types="jest" />
import * as SecureStore from "expo-secure-store";
import { AuthError, cognitoRequest } from "../src/auth/cognito";
import {
  completeNewPassword,
  confirmPassword,
  confirmSignUp,
  refreshSession,
  restoreSession,
  signIn,
  signOut,
  signUp,
} from "../src/auth/session";

jest.mock("expo-secure-store", () => ({
  AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 7,
  setItemAsync: jest.fn(),
  getItemAsync: jest.fn(),
  deleteItemAsync: jest.fn(),
}));
jest.mock("../src/auth/cognito", () => ({
  ...jest.requireActual("../src/auth/cognito"),
  cognitoRequest: jest.fn(),
}));
jest.mock('../src/auth/sessionLock', () => ({ withSessionLock: (work: () => Promise<unknown>) => work() }));
const request = jest.mocked(cognitoRequest);
const identity = {
  Username: "partner",
  UserAttributes: [
    { Name: "sub", Value: "sub-1" },
    { Name: "email", Value: "partner@example.com" },
    { Name: "name", Value: "Partner One" },
  ],
};
const tokens = (refresh = "refresh-one", expires = 3600) => ({
  AuthenticationResult: {
    AccessToken: "access-token",
    RefreshToken: refresh,
    ExpiresIn: expires,
  },
});

beforeEach(async () => {
  await signOut();
  jest.clearAllMocks();
  let stored: string | null = null;
  jest.mocked(SecureStore.setItemAsync).mockImplementation(async (_key, value) => { stored = value; });
  jest.mocked(SecureStore.deleteItemAsync).mockImplementation(async () => { stored = null; });
  jest.mocked(SecureStore.getItemAsync).mockImplementation(async () => stored);
  request.mockImplementation(async (operation) =>
    operation === "InitiateAuth"
      ? tokens()
      : operation === "GetUser"
        ? identity
        : {},
  );
});

test("email login persists only the refresh token and signs out this session", async () => {
  const result = await signIn(" partner@example.com ", "Password123!");
  expect(result).toEqual({
    kind: "signedIn",
    identity: {
      subject: "sub-1",
      email: "partner@example.com",
      name: "Partner One",
    },
  });
  expect(request).toHaveBeenCalledWith(
    "InitiateAuth",
    expect.objectContaining({
      AuthParameters: expect.objectContaining({
        USERNAME: "partner@example.com",
        PASSWORD: "Password123!",
      }),
    }),
  );
  expect(SecureStore.setItemAsync).toHaveBeenCalledWith(
    expect.any(String),
    "refresh-one",
    { keychainAccessible: 7 },
  );
  expect(
    JSON.stringify(jest.mocked(SecureStore.setItemAsync).mock.calls),
  ).not.toContain("Password123!");
  await signOut();
  expect(SecureStore.deleteItemAsync).toHaveBeenCalled();
  expect(request).toHaveBeenCalledWith("RevokeToken", { Token: "refresh-one" });
  expect(request).not.toHaveBeenCalledWith("GlobalSignOut", expect.anything());
});

test("signup, verification and password reset use their respective Cognito operations", async () => {
  await signUp("person@example.com", "Secret123!", "A Partner");
  await confirmSignUp("person@example.com", "123456");
  await confirmPassword("person@example.com", "654321", "NewSecret123!");
  expect(request).toHaveBeenCalledWith(
    "SignUp",
    expect.objectContaining({
      Username: "person@example.com",
      Password: "Secret123!",
    }),
  );
  expect(request).toHaveBeenCalledWith("ConfirmSignUp", {
    Username: "person@example.com",
    ConfirmationCode: "123456",
  });
  expect(request).toHaveBeenCalledWith("ConfirmForgotPassword", {
    Username: "person@example.com",
    ConfirmationCode: "654321",
    Password: "NewSecret123!",
  });
});

test("restoration keeps the stored session when the identity provider is unreachable", async () => {
  jest.mocked(SecureStore.getItemAsync).mockResolvedValue("saved-refresh");
  request.mockRejectedValue(new AuthError("COGNITO_UNREACHABLE"));
  await expect(restoreSession()).rejects.toMatchObject({
    code: "COGNITO_UNREACHABLE",
  });
  expect(SecureStore.deleteItemAsync).not.toHaveBeenCalled();
});

test("a rotated refresh token is saved even when the profile request fails", async () => {
  let profileCalls = 0;
  request.mockImplementation(async (operation) => {
    if (operation === "InitiateAuth") return tokens("refresh-one", 30);
    if (operation === "GetTokensFromRefreshToken")
      return tokens("refresh-two", 30);
    if (operation === "GetUser") {
      if (++profileCalls === 2) throw new AuthError("COGNITO_UNREACHABLE");
      return identity;
    }
    return {};
  });
  await signIn("partner@example.com", "Password123!");
  await expect(refreshSession()).rejects.toMatchObject({
    code: "COGNITO_UNREACHABLE",
  });
  expect(SecureStore.setItemAsync).toHaveBeenLastCalledWith(
    expect.any(String),
    "refresh-two",
    { keychainAccessible: 7 },
  );
  await refreshSession();
  expect(request).toHaveBeenCalledWith("GetTokensFromRefreshToken", {
    RefreshToken: "refresh-two",
  });
});

test("refresh uses a token rotated by another app runtime", async () => {
  request.mockImplementation(async (operation) => {
    if (operation === "InitiateAuth") return tokens("refresh-one", 30);
    if (operation === "GetTokensFromRefreshToken") return tokens("refresh-three", 30);
    if (operation === "GetUser") return identity;
    return {};
  });
  await signIn("partner@example.com", "Password123!");
  jest.mocked(SecureStore.getItemAsync).mockResolvedValue("refresh-two");
  await refreshSession();
  expect(request).toHaveBeenCalledWith("GetTokensFromRefreshToken", { RefreshToken: "refresh-two" });
  expect(SecureStore.setItemAsync).toHaveBeenLastCalledWith(expect.any(String), "refresh-three", { keychainAccessible: 7 });
});

test("temporary-password accounts complete their Cognito challenge before entering the app", async () => {
  request.mockImplementation(async (operation) => {
    if (operation === "InitiateAuth")
      return {
        ChallengeName: "NEW_PASSWORD_REQUIRED",
        Session: "challenge-session",
        ChallengeParameters: { requiredAttributes: '["name"]' },
      };
    if (operation === "RespondToAuthChallenge") return tokens();
    if (operation === "GetUser") return identity;
    return {};
  });
  expect(await signIn("partner@example.com", "temporary")).toEqual({
    kind: "newPassword",
    required: ["name"],
  });
  await completeNewPassword("NewPassword123!", { name: "Partner One" });
  expect(request).toHaveBeenCalledWith(
    "RespondToAuthChallenge",
    expect.objectContaining({
      ChallengeName: "NEW_PASSWORD_REQUIRED",
      ChallengeResponses: expect.objectContaining({
        NEW_PASSWORD: "NewPassword123!",
        "userAttributes.name": "Partner One",
      }),
    }),
  );
});

test("a refresh completing after sign-out cannot restore or retain its rotated token", async () => {
  let resolveRefresh!: (value: ReturnType<typeof tokens>) => void;
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  request.mockImplementation(async (operation) => {
    if (operation === "InitiateAuth") return tokens("refresh-one", 30);
    if (operation === "GetUser") return identity;
    if (operation === "GetTokensFromRefreshToken") {
      markStarted();
      return new Promise((resolve) => {
        resolveRefresh = resolve;
      });
    }
    return {};
  });
  await signIn("partner@example.com", "Password123!");
  const refreshing = refreshSession();
  await started;
  await signOut();
  resolveRefresh(tokens("rotated-token"));
  await expect(refreshing).rejects.toThrow("Session changed");
  expect(request).toHaveBeenCalledWith("RevokeToken", {
    Token: "rotated-token",
  });
  expect(SecureStore.setItemAsync).not.toHaveBeenCalledWith(
    expect.any(String),
    "rotated-token",
    { keychainAccessible: 7 },
  );
});

test("sign-out during secure storage restore cannot resurrect a session", async () => {
  let releaseRead!: (value: string | null) => void;
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  jest.mocked(SecureStore.getItemAsync).mockImplementationOnce(() => {
    markStarted();
    return new Promise((resolve) => { releaseRead = resolve; });
  });
  const restoring = restoreSession();
  await started;
  await signOut();
  releaseRead('stale-refresh');
  await expect(restoring).rejects.toThrow('Session changed');
  expect(request).not.toHaveBeenCalledWith('GetTokensFromRefreshToken', expect.anything());
});
