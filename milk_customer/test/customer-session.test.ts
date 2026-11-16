/// <reference types="jest" />
import * as SecureStore from 'expo-secure-store';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { accessToken, cancelPasswordChange, completePasswordChange, login, loginLocal, signOut, signUp } from '../src/auth/session';

jest.mock('expo-secure-store', () => ({ setItemAsync: jest.fn().mockResolvedValue(undefined), deleteItemAsync: jest.fn().mockResolvedValue(undefined), getItemAsync: jest.fn().mockResolvedValue(null) }));
jest.mock('@react-native-async-storage/async-storage', () => require('@react-native-async-storage/async-storage/jest/async-storage-mock'));
const fetchMock = jest.fn();
const oldApi = process.env.EXPO_PUBLIC_API_URL;
const oldMode = process.env.EXPO_PUBLIC_AUTH_MODE;
const oldRegion = process.env.EXPO_PUBLIC_COGNITO_REGION;
const oldClientId = process.env.EXPO_PUBLIC_COGNITO_CLIENT_ID;

afterAll(() => { process.env.EXPO_PUBLIC_API_URL = oldApi; process.env.EXPO_PUBLIC_AUTH_MODE = oldMode; process.env.EXPO_PUBLIC_COGNITO_REGION = oldRegion; process.env.EXPO_PUBLIC_COGNITO_CLIENT_ID = oldClientId; });

test('local sign in bootstraps with the ID token and uses the access token for API calls', async () => {
  process.env.EXPO_PUBLIC_API_URL = 'http://192.168.1.10:3000';
  process.env.EXPO_PUBLIC_AUTH_MODE = 'local';
  globalThis.fetch = fetchMock;
  fetchMock.mockReset();
  fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ token: 'id-token' }), { status: 200 }))
    .mockResolvedValueOnce(new Response(JSON.stringify({ userId: 'customer' }), { status: 201 }))
    .mockResolvedValueOnce(new Response(JSON.stringify({ token: 'access-token' }), { status: 200 }));
  await loginLocal();
  expect(await accessToken()).toBe('access-token');
  expect(fetchMock.mock.calls[1][1].headers.Authorization).toBe('Bearer id-token');
  expect(JSON.parse(fetchMock.mock.calls[2][1].body).tokenUse).toBe('access');
  await signOut();
  await expect(accessToken()).rejects.toThrow('Sign in');
  expect(SecureStore.deleteItemAsync).toHaveBeenCalled();
});

test('Cognito sign in bootstraps the backend before storing the access session', async () => {
  process.env.EXPO_PUBLIC_API_URL = 'http://192.168.1.10:3000';
  process.env.EXPO_PUBLIC_AUTH_MODE = 'cognito';
  process.env.EXPO_PUBLIC_COGNITO_REGION = 'ap-south-1';
  process.env.EXPO_PUBLIC_COGNITO_CLIENT_ID = 'publicclient123';
  globalThis.fetch = fetchMock;
  fetchMock.mockReset();
  fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ AuthenticationResult: { IdToken: 'id', AccessToken: 'access', RefreshToken: 'refresh', ExpiresIn: 3600 } }), { status: 200 }))
    .mockResolvedValueOnce(new Response(JSON.stringify({ userId: 'customer' }), { status: 201 }))
    .mockResolvedValueOnce(new Response('{}', { status: 200 }));
  await login('person@example.com', 'test-password');
  expect(fetchMock.mock.calls[0][0]).toBe('https://cognito-idp.ap-south-1.amazonaws.com/');
  expect(fetchMock.mock.calls[0][1].headers['X-Amz-Target']).toBe('AWSCognitoIdentityProviderService.InitiateAuth');
  expect(JSON.parse(fetchMock.mock.calls[0][1].body).AuthFlow).toBe('USER_AUTH');
  expect(fetchMock.mock.calls[1][1].headers.Authorization).toBe('Bearer id');
  expect(await accessToken()).toBe('access');
  await signOut();
});

test('customer sign-in refreshes its token until the customer group is ready', async () => {
  process.env.EXPO_PUBLIC_API_URL = 'http://192.168.1.10:3000';
  process.env.EXPO_PUBLIC_AUTH_MODE = 'cognito';
  process.env.EXPO_PUBLIC_COGNITO_REGION = 'ap-southeast-2';
  process.env.EXPO_PUBLIC_COGNITO_CLIENT_ID = 'publicclient123';
  globalThis.fetch = fetchMock; fetchMock.mockReset();
  fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ AuthenticationResult: { IdToken: 'id', AccessToken: 'old', RefreshToken: 'refresh' } }), { status: 200 }))
    .mockResolvedValueOnce(new Response(JSON.stringify({ userId: 'customer' }), { status: 201 }))
    .mockResolvedValueOnce(new Response(JSON.stringify({ code: 'FORBIDDEN' }), { status: 403 }))
    .mockResolvedValueOnce(new Response(JSON.stringify({ AuthenticationResult: { AccessToken: 'grouped' } }), { status: 200 }))
    .mockResolvedValueOnce(new Response(JSON.stringify({ userId: 'customer' }), { status: 200 }))
    .mockResolvedValueOnce(new Response('{}', { status: 200 }));
  jest.useFakeTimers();
  try {
    const pending = login('person@example.com', 'test-password');
    await jest.advanceTimersByTimeAsync(1500);
    await pending;
    expect(await accessToken()).toBe('grouped');
    expect(JSON.parse(fetchMock.mock.calls[3][1].body).AuthFlow).toBe('REFRESH_TOKEN_AUTH');
    await signOut();
  } finally { jest.useRealTimers(); }
});

test('Cognito password challenge completes before backend bootstrap', async () => {
  process.env.EXPO_PUBLIC_API_URL = 'http://192.168.1.10:3000';
  process.env.EXPO_PUBLIC_AUTH_MODE = 'cognito';
  process.env.EXPO_PUBLIC_COGNITO_REGION = 'ap-southeast-2';
  process.env.EXPO_PUBLIC_COGNITO_CLIENT_ID = 'publicclient123';
  globalThis.fetch = fetchMock;
  fetchMock.mockReset();
  fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ ChallengeName: 'PASSWORD', Session: 'challenge' }), { status: 200 }))
    .mockResolvedValueOnce(new Response(JSON.stringify({ AuthenticationResult: { IdToken: 'id', AccessToken: 'access', RefreshToken: 'refresh', ExpiresIn: 3600 } }), { status: 200 }))
    .mockResolvedValueOnce(new Response(JSON.stringify({ userId: 'customer' }), { status: 201 }))
    .mockResolvedValueOnce(new Response('{}', { status: 200 }));
  await login('person@example.com', 'test-password');
  expect(fetchMock.mock.calls[1][1].headers['X-Amz-Target']).toBe('AWSCognitoIdentityProviderService.RespondToAuthChallenge');
  expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toMatchObject({ Session: 'challenge', ChallengeName: 'PASSWORD' });
  expect(fetchMock.mock.calls[2][1].headers.Authorization).toBe('Bearer id');
  await signOut();
});

test('a signup referral survives verification and is submitted only at bootstrap', async () => {
  process.env.EXPO_PUBLIC_API_URL = 'http://192.168.1.10:3000';
  process.env.EXPO_PUBLIC_AUTH_MODE = 'cognito';
  process.env.EXPO_PUBLIC_COGNITO_REGION = 'ap-southeast-2';
  process.env.EXPO_PUBLIC_COGNITO_CLIENT_ID = 'publicclient123';
  await AsyncStorage.clear(); globalThis.fetch = fetchMock; fetchMock.mockReset();
  fetchMock.mockResolvedValueOnce(new Response('{}', {status:200}))
    .mockResolvedValueOnce(new Response(JSON.stringify({AuthenticationResult:{IdToken:'id',AccessToken:'access',RefreshToken:'refresh'}}),{status:200}))
    .mockResolvedValueOnce(new Response(JSON.stringify({userId:'customer'}),{status:201}))
    .mockResolvedValueOnce(new Response('{}',{status:200}));
  await signUp('person@example.com','test-password','Customer','ABCDEF0123456789');
  await login('person@example.com','test-password');
  expect(JSON.parse(fetchMock.mock.calls[2][1].body)).toEqual({referralCode:'ABCDEF0123456789'});
  expect(await AsyncStorage.getItem('@dairydirect/signup-referral-v1:person%40example.com')).toBeNull();
  await signOut();
});

test('a successful Cognito login does not save a session when the customer server is unreachable', async () => {
  process.env.EXPO_PUBLIC_API_URL = 'http://192.168.1.10:3000';
  process.env.EXPO_PUBLIC_AUTH_MODE = 'cognito';
  process.env.EXPO_PUBLIC_COGNITO_REGION = 'ap-southeast-2';
  process.env.EXPO_PUBLIC_COGNITO_CLIENT_ID = 'publicclient123';
  globalThis.fetch = fetchMock; fetchMock.mockReset(); jest.clearAllMocks();
  fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({AuthenticationResult:{IdToken:'id',AccessToken:'access',RefreshToken:'refresh'}}), {status:200}))
    .mockRejectedValueOnce(new TypeError('Network request failed'));
  await expect(login('person@example.com', 'test-password')).rejects.toMatchObject({ code: 'BACKEND_UNREACHABLE' });
  expect(SecureStore.setItemAsync).not.toHaveBeenCalled();
  await expect(accessToken()).rejects.toThrow('Sign in');
});

test('temporary password challenge accepts the new password and only the requested attributes', async () => {
  process.env.EXPO_PUBLIC_API_URL = 'http://192.168.1.10:3000';
  process.env.EXPO_PUBLIC_AUTH_MODE = 'cognito';
  process.env.EXPO_PUBLIC_COGNITO_REGION = 'ap-southeast-2';
  process.env.EXPO_PUBLIC_COGNITO_CLIENT_ID = 'publicclient123';
  globalThis.fetch = fetchMock; fetchMock.mockReset();
  fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ ChallengeName:'NEW_PASSWORD_REQUIRED', Session:'temporary-session', ChallengeParameters:{requiredAttributes:'["userAttributes.name"]'} }), {status:200}))
    .mockResolvedValueOnce(new Response(JSON.stringify({AuthenticationResult:{IdToken:'id',AccessToken:'access',RefreshToken:'refresh'}}), {status:200}))
    .mockResolvedValueOnce(new Response(JSON.stringify({userId:'customer'}), {status:201}))
    .mockResolvedValueOnce(new Response('{}', {status:200}));
  expect(await login('person@example.com', 'temporary-password')).toEqual({kind:'newPasswordRequired', requiredAttributes:['name']});
  expect(fetchMock).toHaveBeenCalledTimes(1);
  await completePasswordChange('New-password-123!', {name:'Person', phone_number:'+919999999999'});
  expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toMatchObject({
    Session:'temporary-session', ChallengeName:'NEW_PASSWORD_REQUIRED',
    ChallengeResponses:{USERNAME:'person@example.com',NEW_PASSWORD:'New-password-123!','userAttributes.name':'Person'},
  });
  expect(JSON.parse(fetchMock.mock.calls[1][1].body).ChallengeResponses['userAttributes.phone_number']).toBeUndefined();
  expect(await accessToken()).toBe('access');
  await signOut();
});

test('a password already changed at Cognito is not submitted twice when bootstrap fails', async () => {
  process.env.EXPO_PUBLIC_API_URL = 'http://192.168.1.10:3000';
  process.env.EXPO_PUBLIC_AUTH_MODE = 'cognito';
  process.env.EXPO_PUBLIC_COGNITO_REGION = 'ap-southeast-2';
  process.env.EXPO_PUBLIC_COGNITO_CLIENT_ID = 'publicclient123';
  globalThis.fetch = fetchMock; fetchMock.mockReset();
  fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ ChallengeName:'NEW_PASSWORD_REQUIRED', Session:'temporary-session' }), {status:200}))
    .mockResolvedValueOnce(new Response(JSON.stringify({AuthenticationResult:{IdToken:'id',AccessToken:'access',RefreshToken:'refresh'}}), {status:200}))
    .mockRejectedValueOnce(new TypeError('Network request failed'));
  await login('person@example.com', 'temporary-password');
  await expect(completePasswordChange('New-password-123!', {})).rejects.toMatchObject({name:'PasswordChangedError',original:{code:'BACKEND_UNREACHABLE'}});
  await expect(completePasswordChange('New-password-123!', {})).rejects.toMatchObject({code:'CHALLENGE_EXPIRED'});
  cancelPasswordChange();
});

test('a lost password-change response is treated as uncertain instead of repeating the change', async () => {
  process.env.EXPO_PUBLIC_AUTH_MODE = 'cognito';
  process.env.EXPO_PUBLIC_COGNITO_REGION = 'ap-southeast-2';
  process.env.EXPO_PUBLIC_COGNITO_CLIENT_ID = 'publicclient123';
  globalThis.fetch = fetchMock; fetchMock.mockReset();
  fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ ChallengeName:'NEW_PASSWORD_REQUIRED', Session:'temporary-session' }), {status:200}))
    .mockRejectedValueOnce(new TypeError('Network request failed'));
  await login('person@example.com', 'temporary-password');
  await expect(completePasswordChange('New-password-123!', {})).rejects.toMatchObject({name:'PasswordChangeUncertainError'});
  await expect(completePasswordChange('New-password-123!', {})).rejects.toMatchObject({code:'CHALLENGE_EXPIRED'});
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

test('a rejected duplicate signup restores the previously saved referral', async () => {
  process.env.EXPO_PUBLIC_AUTH_MODE = 'cognito';
  process.env.EXPO_PUBLIC_COGNITO_REGION = 'ap-southeast-2';
  process.env.EXPO_PUBLIC_COGNITO_CLIENT_ID = 'publicclient123';
  await AsyncStorage.clear();
  const key = '@dairydirect/signup-referral-v1:person%40example.com';
  await AsyncStorage.setItem(key, 'AAAAAAAAAAAAAAAA');
  globalThis.fetch = fetchMock; fetchMock.mockReset();
  fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({__type:'UsernameExistsException'}), {status:400}));
  await expect(signUp('person@example.com','test-password','Person','BBBBBBBBBBBBBBBB')).rejects.toMatchObject({code:'ACCOUNT_EXISTS'});
  expect(await AsyncStorage.getItem(key)).toBe('AAAAAAAAAAAAAAAA');
});
