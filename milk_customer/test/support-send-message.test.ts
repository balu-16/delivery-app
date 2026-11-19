import AsyncStorage from '@react-native-async-storage/async-storage';
import { customerDetailsApi } from '../src/api/customer';
import { sendSupportMessage, supportSendError } from '../src/support/send-message';
import { ApiError } from '../src/api/client';

jest.mock('@react-native-async-storage/async-storage', () => require('@react-native-async-storage/async-storage/jest/async-storage-mock'));
jest.mock('expo-crypto', () => ({CryptoDigestAlgorithm:{SHA256:'SHA256'},digestStringAsync:jest.fn(async (_algorithm:string, value:string) => `hash:${value}`),randomUUID:jest.fn(() => 'safe-key')}));
jest.mock('../src/api/customer', () => ({customerDetailsApi:{createTicket:jest.fn(),ticketMessage:jest.fn()}}));

beforeEach(async () => {await AsyncStorage.clear();jest.clearAllMocks();});
test('an uncertain submission survives a restart and retries with the original key', async () => {
  const create = jest.mocked(customerDetailsApi.createTicket);
  create.mockRejectedValueOnce(new TypeError('offline')).mockResolvedValueOnce({id:'ticket'});
  await expect(sendSupportMessage('user','token','Help',null)).rejects.toThrow();
  await expect(sendSupportMessage('user','token','Different message',null)).rejects.toThrow('SUPPORT_RECOVERY_REQUIRED');
  expect(create).toHaveBeenCalledTimes(1);
  await expect(sendSupportMessage('user','token','Help',null)).resolves.toEqual({id:'ticket'});
  expect(create.mock.calls.map(call => call[2])).toEqual(['safe-key','safe-key']);
  expect(await AsyncStorage.getItem('@dairydirect/support-request:user:new')).toBeNull();
});

test('uncertain submissions use the checking message without leaking references', () => {
  expect(supportSendError(new TypeError('offline'))).toBe('We’re checking if your message was sent.');
  expect(supportSendError(new ApiError(503, 'UP', 'trace-9'))).toBe('We’re checking if your message was sent.');
  expect(supportSendError(new ApiError(503, 'UP', 'trace-9'))).not.toContain('trace-9');
  expect(supportSendError(new ApiError(401, 'SESSION_EXPIRED'))).toBe('Sign in again to continue.');
});
