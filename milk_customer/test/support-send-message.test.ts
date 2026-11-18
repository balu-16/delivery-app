import AsyncStorage from '@react-native-async-storage/async-storage';
import { customerDetailsApi } from '../src/api/customer';
import { sendSupportMessage } from '../src/support/send-message';

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
