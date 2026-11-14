/// <reference types="jest" />
import Constants from 'expo-constants';
import { apiBaseUrl, customerRequest } from '../src/api/client';
import { ApiAddressError, resolveApiAddress } from '../src/api/address';

jest.mock('expo-constants', () => ({
  __esModule: true,
  default: { expoConfig: { hostUri: '172.16.1.10:8081', extra: { developmentApiPort: '13080' } }, experienceUrl: '' },
}));

const previousUrl = process.env.EXPO_PUBLIC_API_URL;
const previousPort = process.env.EXPO_PUBLIC_API_PORT;
const previousFetch = globalThis.fetch;

beforeEach(() => {
  process.env.EXPO_PUBLIC_API_URL = '';
  delete process.env.EXPO_PUBLIC_API_PORT;
  Constants.expoConfig!.hostUri = '172.16.1.10:8081';
  Constants.expoConfig!.extra = { developmentApiPort: '13080' };
});
afterAll(() => {
  process.env.EXPO_PUBLIC_API_URL = previousUrl;
  process.env.EXPO_PUBLIC_API_PORT = previousPort;
  globalThis.fetch = previousFetch;
});

test('follows the Expo LAN address and the backend port from the manifest', () => {
  expect(apiBaseUrl()).toBe('http://172.16.1.10:13080');
  Constants.expoConfig!.hostUri = '192.168.55.12:8081';
  Constants.expoConfig!.extra = { developmentApiPort: '3000' };
  expect(apiBaseUrl()).toBe('http://192.168.55.12:3000');
});

test('customer requests use the discovered address', async () => {
  const fetchMock = jest.fn().mockResolvedValue(new Response('{}', { status: 200 }));
  globalThis.fetch = fetchMock;
  await customerRequest('/v1/customer/me', { token: 'test-token' });
  expect(fetchMock).toHaveBeenCalledWith('http://172.16.1.10:13080/v1/customer/me', expect.objectContaining({
    headers: expect.objectContaining({ Authorization: 'Bearer test-token' }),
  }));
});

test('supports a custom port and IPv6, and lets an explicit remote URL take precedence', () => {
  process.env.EXPO_PUBLIC_API_PORT = '4000';
  expect(apiBaseUrl()).toBe('http://172.16.1.10:4000');
  expect(resolveApiAddress({ development: true, developmentHost: 'exp://[fd00::1]:8081', developmentPort: '3000' }))
    .toBe('http://[fd00::1]:3000');
  expect(resolveApiAddress({ configuredUrl: 'https://api.example.test/', development: true, developmentHost: '172.16.1.10:8081' }))
    .toBe('https://api.example.test');
});

test('requires an explicit HTTPS API outside development', () => {
  expect(() => resolveApiAddress({ development: false, developmentHost: '172.16.1.10:8081' }))
    .toThrow('Set EXPO_PUBLIC_API_URL');
  expect(() => resolveApiAddress({ development: false, configuredUrl: 'http://192.168.1.10:3000' }))
    .toThrow('must use HTTPS');
  expect(resolveApiAddress({ development: false, configuredUrl: 'https://api.example.test' }))
    .toBe('https://api.example.test');
});

test('rejects missing or public Expo hosts and invalid ports', () => {
  expect(() => resolveApiAddress({ development: true })).toThrow(ApiAddressError);
  expect(() => resolveApiAddress({ development: true, developmentHost: 'example.exp.direct:443' }))
    .toThrow('Could not find the local customer server');
  expect(() => resolveApiAddress({ development: true, developmentHost: '172.16.1.10:8081', developmentPort: '70000' }))
    .toThrow('port is invalid');
  expect(() => resolveApiAddress({ development: true, developmentHost: 'exp://user:secret@192.168.1.10:8081' }))
    .toThrow('Could not find the local customer server');
});
