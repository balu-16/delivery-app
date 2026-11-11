/// <reference types="jest" />
import * as SecureStore from 'expo-secure-store';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { accessToken, login, loginLocal, signOut, signUp } from '../src/auth/session';

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
