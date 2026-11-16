/// <reference types="jest" />
import { waitFor } from '@testing-library/react-native';
import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import * as Notifications from 'expo-notifications';
import { customerDetailsApi } from '../src/api/customer';
import { disablePushNotifications, enablePushNotifications, startPushSession, unregisterPushBeforeSignOut, usePushStatus } from '../src/notifications/push';

jest.mock('expo-constants', () => ({__esModule:true,default:{appOwnership:null}}));
jest.mock('expo-secure-store', () => ({getItemAsync:jest.fn(),setItemAsync:jest.fn(),deleteItemAsync:jest.fn()}));
jest.mock('../src/auth/session', () => ({accessToken:jest.fn(async () => 'session-token')}));
jest.mock('../src/api/customer', () => ({customerDetailsApi:{registerDevice:jest.fn(),unregisterDevice:jest.fn()}}));
jest.mock('expo-notifications', () => ({
  AndroidImportance:{HIGH:4},
  setNotificationChannelAsync:jest.fn(async () => undefined),
  getPermissionsAsync:jest.fn(async () => ({granted:true,canAskAgain:true})),
  requestPermissionsAsync:jest.fn(async () => ({granted:true,canAskAgain:true})),
  getDevicePushTokenAsync:jest.fn(async () => ({type:'android',data:'a-valid-android-fcm-device-token'})),
  setNotificationHandler:jest.fn(),
  addPushTokenListener:jest.fn(() => ({remove:jest.fn()})),
  addNotificationReceivedListener:jest.fn(() => ({remove:jest.fn()})),
  addNotificationResponseReceivedListener:jest.fn(() => ({remove:jest.fn()})),
  getLastNotificationResponseAsync:jest.fn(async () => null),
  clearLastNotificationResponseAsync:jest.fn(async () => undefined),
}));

const secure = jest.mocked(SecureStore);
const api = jest.mocked(customerDetailsApi);
let saved:string | null;
beforeEach(() => {
  Object.defineProperty(Platform,'OS',{configurable:true,value:'android'});
  saved = null; jest.clearAllMocks();
  secure.getItemAsync.mockImplementation(async () => saved);
  secure.setItemAsync.mockImplementation(async (_key,value) => {saved=value;});
  secure.deleteItemAsync.mockImplementation(async () => {saved=null;});
  api.registerDevice.mockResolvedValue({registered:true});
  api.unregisterDevice.mockResolvedValue({removed:true});
  usePushStatus.setState({status:'checking',message:''});
});

test('registers an opted-in Android FCM token and removes it at sign-out', async () => {
  const stop = startPushSession('user-1',jest.fn(),jest.fn());
  await waitFor(() => expect(usePushStatus.getState().status).toBe('available'));
  await enablePushNotifications('user-1');
  expect(Notifications.getDevicePushTokenAsync).toHaveBeenCalledTimes(1);
  expect(api.registerDevice).toHaveBeenCalledWith('session-token','a-valid-android-fcm-device-token');
  expect(usePushStatus.getState().status).toBe('enabled');
  await unregisterPushBeforeSignOut('user-1');
  expect(api.unregisterDevice).toHaveBeenCalledWith('session-token','a-valid-android-fcm-device-token');
  expect(saved).toBeNull();
  stop();
});

test('waits for an in-flight registration before unregistering on sign-out', async () => {
  let complete:(() => void) | undefined;
  api.registerDevice.mockImplementation(() => new Promise(resolve => {complete=() => resolve({registered:true});}));
  const stop = startPushSession('user-1',jest.fn(),jest.fn());
  await waitFor(() => expect(usePushStatus.getState().status).toBe('available'));
  const enabling = enablePushNotifications('user-1');
  await waitFor(() => expect(api.registerDevice).toHaveBeenCalled());
  const signingOut = unregisterPushBeforeSignOut('user-1');
  complete?.();
  await enabling;
  await signingOut;
  expect(api.unregisterDevice).toHaveBeenCalledTimes(1);
  expect(saved).toBeNull();
  stop();
});

test('keeps the device record when sign-out cannot revoke alerts', async () => {
  const stop = startPushSession('user-1',jest.fn(),jest.fn());
  await waitFor(() => expect(usePushStatus.getState().status).toBe('available'));
  await enablePushNotifications('user-1');
  api.unregisterDevice.mockRejectedValueOnce(new TypeError('offline'));
  await expect(unregisterPushBeforeSignOut('user-1')).rejects.toThrow('Connect to the internet');
  expect(saved).not.toBeNull();
  stop();
});

test('turns off delivery alerts and preserves the record if revocation fails', async () => {
  const stop = startPushSession('user-1',jest.fn(),jest.fn());
  await waitFor(() => expect(usePushStatus.getState().status).toBe('available'));
  await enablePushNotifications('user-1');
  api.unregisterDevice.mockRejectedValueOnce(new TypeError('offline'));
  await disablePushNotifications('user-1');
  expect(usePushStatus.getState().status).toBe('enabled');
  expect(saved).not.toBeNull();
  await disablePushNotifications('user-1');
  expect(usePushStatus.getState().status).toBe('available');
  expect(saved).toBeNull();
  stop();
});

test('revokes a saved device even when the profile did not load before sign-out', async () => {
  const stop = startPushSession('user-1',jest.fn(),jest.fn());
  await waitFor(() => expect(usePushStatus.getState().status).toBe('available'));
  await enablePushNotifications('user-1');
  await unregisterPushBeforeSignOut(undefined);
  expect(api.unregisterDevice).toHaveBeenCalledTimes(1);
  expect(saved).toBeNull();
  stop();
});
