/// <reference types="jest" />
import Constants from 'expo-constants';
import { apiBase } from '../src/api';
import { resolveApiAddress } from '../src/apiAddress';

jest.mock('expo-constants', () => ({
  __esModule: true,
  default: { expoConfig: { hostUri: '192.168.1.20:8081' }, experienceUrl: '' },
}));
jest.mock('../src/auth/session', () => ({ getAccessToken: jest.fn(), getIdToken: jest.fn() }));

afterEach(() => {
  delete process.env.EXPO_PUBLIC_API_URL;
  delete process.env.EXPO_PUBLIC_API_PORT;
});

test('the API follows the current Expo LAN host without a configured IP', () => {
  process.env.EXPO_PUBLIC_API_URL = '';
  expect(apiBase()).toBe('http://192.168.1.20:13080');
  Constants.expoConfig!.hostUri = '10.4.5.6:8081';
  expect(apiBase()).toBe('http://10.4.5.6:13080');
});

test('local discovery supports a custom backend port and IPv6', () => {
  expect(resolveApiAddress({ development: true, developmentHost: 'exp://192.168.10.4:8081', developmentPort: '3000' }))
    .toBe('http://192.168.10.4:3000');
  expect(resolveApiAddress({ development: true, developmentHost: '[fd00::1]:8081' }))
    .toBe('http://[fd00::1]:13080');
});

test('an explicit backend overrides discovery and release builds require HTTPS', () => {
  expect(resolveApiAddress({ configuredUrl: 'https://api.example.com/', development: true, developmentHost: '192.168.1.10:8081' }))
    .toBe('https://api.example.com');
  expect(() => resolveApiAddress({ development: false, developmentHost: '192.168.1.10:8081' })).toThrow('BACKEND_CONFIGURATION');
  expect(() => resolveApiAddress({ configuredUrl: 'http://192.168.1.10:13080', development: false })).toThrow('BACKEND_CONFIGURATION');
  expect(() => resolveApiAddress({ configuredUrl: 'https://user:secret@api.example.com', development: true })).toThrow('BACKEND_CONFIGURATION');
});

test('discovery rejects missing hosts, public tunnel hosts and invalid ports', () => {
  expect(() => resolveApiAddress({ development: true })).toThrow('BACKEND_DISCOVERY');
  expect(() => resolveApiAddress({ development: true, developmentHost: 'example.exp.direct:443' })).toThrow('BACKEND_DISCOVERY');
  expect(() => resolveApiAddress({ development: true, developmentHost: '192.168.1.10:8081', developmentPort: '70000' })).toThrow('BACKEND_CONFIGURATION');
});
