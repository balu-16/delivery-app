/// <reference types="jest" />
import * as SecureStore from 'expo-secure-store';
import { login } from '../src/auth/session';

jest.mock('expo-constants', () => ({
  __esModule: true,
  default: { expoConfig: null, experienceUrl: '' },
}));
jest.mock('expo-secure-store', () => ({
  setItemAsync: jest.fn(), deleteItemAsync: jest.fn(), getItemAsync: jest.fn().mockResolvedValue(null),
}));
jest.mock('@react-native-async-storage/async-storage', () => require('@react-native-async-storage/async-storage/jest/async-storage-mock'));

test('sign-in reports a missing Expo host without sending a token to an unknown server', async () => {
  const previous = {
    url: process.env.EXPO_PUBLIC_API_URL, mode: process.env.EXPO_PUBLIC_AUTH_MODE,
    region: process.env.EXPO_PUBLIC_COGNITO_REGION, client: process.env.EXPO_PUBLIC_COGNITO_CLIENT_ID,
    fetch: globalThis.fetch,
  };
  process.env.EXPO_PUBLIC_API_URL = '';
  process.env.EXPO_PUBLIC_AUTH_MODE = 'cognito';
  process.env.EXPO_PUBLIC_COGNITO_REGION = 'ap-southeast-2';
  process.env.EXPO_PUBLIC_COGNITO_CLIENT_ID = 'publicclient123';
  const fetchMock = jest.fn().mockResolvedValue(new Response(JSON.stringify({
    AuthenticationResult: { IdToken: 'id', AccessToken: 'access', RefreshToken: 'refresh' },
  }), { status: 200 }));
  globalThis.fetch = fetchMock;
  try {
    await expect(login('person@example.test', 'test-password')).rejects.toMatchObject({ code: 'BACKEND_DISCOVERY' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(SecureStore.setItemAsync).not.toHaveBeenCalled();
  } finally {
    process.env.EXPO_PUBLIC_API_URL = previous.url;
    process.env.EXPO_PUBLIC_AUTH_MODE = previous.mode;
    process.env.EXPO_PUBLIC_COGNITO_REGION = previous.region;
    process.env.EXPO_PUBLIC_COGNITO_CLIENT_ID = previous.client;
    globalThis.fetch = previous.fetch;
  }
});
