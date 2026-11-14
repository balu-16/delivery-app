/// <reference types="jest" />
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Crypto from 'expo-crypto';
import { performAction } from '../src/actions';
import { ApiError, request, riderApi } from '../src/api';
import { getAccessToken, getIdToken } from '../src/auth/session';

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'));
jest.mock('expo-crypto', () => ({ randomUUID: jest.fn() }));
jest.mock('../src/auth/session', () => ({ getAccessToken: jest.fn(), getIdToken: jest.fn() }));

const fetchMock = jest.fn();
const response = (status: number, data: unknown) => ({
  status, ok: status >= 200 && status < 300, text: async () => data === null ? '' : JSON.stringify(data),
});

beforeEach(async () => {
  jest.clearAllMocks();
  await AsyncStorage.clear();
  process.env.EXPO_PUBLIC_API_URL = 'http://localhost:3000';
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  jest.mocked(getAccessToken).mockResolvedValue('access-token');
  jest.mocked(getIdToken).mockResolvedValue('id-token');
  jest.mocked(Crypto.randomUUID).mockReturnValue('123e4567-e89b-42d3-a456-426614174000');
});

test('rider bootstrap uses the ID token and the configured backend', async () => {
  fetchMock.mockResolvedValue(response(201, { userId: 'rider', status: 'PENDING', groupPending: true }));
  expect(await riderApi.bootstrap()).toEqual({ userId: 'rider', status: 'PENDING', groupPending: true });
  expect(fetchMock).toHaveBeenCalledWith('http://localhost:3000/v1/rider/auth/bootstrap', expect.objectContaining({
    method: 'POST', headers: expect.objectContaining({ Authorization: 'Bearer id-token' }),
  }));
  expect(getAccessToken).not.toHaveBeenCalled();
});

test('an expired access token is refreshed before a single safe retry', async () => {
  fetchMock.mockResolvedValueOnce(response(401, { code: 'INVALID_TOKEN' })).mockResolvedValueOnce(response(200, { ok: true }));
  await expect(request('/v1/rider/tasks/abc/picked-up', { method: 'POST', body: {}, key: 'same-key' })).resolves.toEqual({ ok: true });
  expect(getAccessToken).toHaveBeenCalledWith(true);
  expect(fetchMock).toHaveBeenCalledTimes(2);
  for (const call of fetchMock.mock.calls) expect(call[1].headers['Idempotency-Key']).toBe('same-key');
});

test('uncertain delivery actions keep the same key without storing the payload', async () => {
  let first = '';
  await expect(performAction('rider', 'task', 'deliver', async (key) => {
    first = key;
    throw new ApiError('NETWORK_ERROR', 0);
  })).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
  const keys = await AsyncStorage.getAllKeys();
  expect(keys).toHaveLength(1);
  expect(await AsyncStorage.getItem(keys[0]!)).toBe(first);
  const result = await performAction('rider', 'task', 'deliver', async (key) => {
    expect(key).toBe(first);
    return 'confirmed';
  });
  expect(result).toBe('confirmed');
  expect(await AsyncStorage.getAllKeys()).toHaveLength(0);
});

test('a definite rejected request clears its action key', async () => {
  await expect(performAction('rider', 'task', 'deliver', async () => { throw new ApiError('DELIVERY_CODE_INVALID', 400); })).rejects.toThrow();
  expect(await AsyncStorage.getAllKeys()).toHaveLength(0);
});
