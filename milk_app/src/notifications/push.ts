import Constants from 'expo-constants';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';
import { create } from 'zustand';
import { ApiError } from '@/src/api/client';
import { customerDetailsApi } from '@/src/api/customer';
import { accessToken } from '@/src/auth/session';

type PushStatus = 'checking' | 'available' | 'enabled' | 'busy' | 'expo-go' | 'unsupported' | 'error';
type DeviceRecord = { userId: string; tokens: string[]; primary: string };
type NotificationsModule = typeof import('expo-notifications');
// Keep native notification initialization out of Expo Go and web.
function notificationsModule():NotificationsModule {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('expo-notifications') as NotificationsModule;
}
const DEVICE_KEY = 'dairydirect.customer.push-device.v1';
let generation = 0;
let suspended = false;
let queue: Promise<void> = Promise.resolve();

export const usePushStatus = create<{status:PushStatus; message:string}>()(() => ({status:'checking', message:''}));
const setStatus = (status:PushStatus, message = '') => usePushStatus.setState({status,message});
function supported(): PushStatus | null {
  if (Platform.OS !== 'android') return 'unsupported';
  // Unlike executionEnvironment, appOwnership distinguishes Expo Go from a development build.
  if (Constants.appOwnership === 'expo') return 'expo-go';
  return null;
}
function serial<T>(work:() => Promise<T>):Promise<T> {
  const result = queue.then(work, work);
  queue = result.then(() => undefined, () => undefined);
  return result;
}
async function readDevice(): Promise<DeviceRecord | null> {
  const raw = await SecureStore.getItemAsync(DEVICE_KEY);
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as DeviceRecord;
    if (typeof value.userId !== 'string' || !Array.isArray(value.tokens) || !value.tokens.length || value.tokens.some(token => typeof token !== 'string' || token.length < 16) || !value.tokens.includes(value.primary)) throw new Error('Invalid device record');
    return value;
  } catch { throw new Error('Could not read this device’s notification settings.'); }
}
async function unregister(token:string, sessionToken:string) {
  try { await customerDetailsApi.unregisterDevice(sessionToken,token); }
  catch (error) { if (!(error instanceof ApiError && error.status === 404)) throw error; }
}
async function register(userId:string, nativeToken:string, expected:number, force = false) {
  if (suspended || expected !== generation) return;
  if (nativeToken.length < 16 || nativeToken.length > 4096 || /\s/.test(nativeToken)) throw new Error('Invalid device token');
  const previous = await readDevice();
  if (previous && previous.userId !== userId) throw new Error('Notification settings belong to another account.');
  if (!force && previous?.primary === nativeToken && usePushStatus.getState().status === 'enabled') return;
  const record:DeviceRecord = {userId,primary:nativeToken,tokens:[...new Set([...(previous?.tokens ?? []),nativeToken])]};
  // Save every potentially registered token before making the request, including ambiguous failures.
  await SecureStore.setItemAsync(DEVICE_KEY,JSON.stringify(record));
  if (suspended || expected !== generation) return;
  const sessionToken = await accessToken();
  await customerDetailsApi.registerDevice(sessionToken,nativeToken);
  const remaining = [nativeToken];
  for (const oldToken of record.tokens) {
    if (oldToken === nativeToken) continue;
    try { await unregister(oldToken,sessionToken); } catch { remaining.push(oldToken); }
  }
  await SecureStore.setItemAsync(DEVICE_KEY,JSON.stringify({...record,tokens:remaining}));
  if (!suspended && expected === generation) setStatus('enabled');
}
async function synchronize(userId:string, expected:number, askPermission:boolean) {
  return serial(async () => {
    if (suspended || expected !== generation) return;
    const unsupported = supported();
    if (unsupported) {setStatus(unsupported);return;}
    setStatus('busy');
    try {
      const saved = await readDevice();
      if (!askPermission && (!saved || saved.userId !== userId)) {setStatus('available');return;}
      const Notifications = notificationsModule();
      await Notifications.setNotificationChannelAsync('default',{name:'Delivery updates',importance:Notifications.AndroidImportance.HIGH});
      let permission = await Notifications.getPermissionsAsync();
      if (!permission.granted && askPermission) permission = await Notifications.requestPermissionsAsync();
      if (!permission.granted) {setStatus('available', permission.canAskAgain ? '' : 'Allow notifications in your device settings to receive alerts.');return;}
      const token = await Notifications.getDevicePushTokenAsync();
      if (token.type !== 'android' || typeof token.data !== 'string') throw new Error('No Android token');
      await register(userId,token.data,expected,true);
    } catch {
      if (!suspended && expected === generation) setStatus('error','Could not enable delivery alerts. Check your connection and try again.');
    }
  });
}
export function enablePushNotifications(userId:string) { return synchronize(userId,generation,true); }

export async function disablePushNotifications(userId:string) {
  if (Platform.OS !== 'android' || suspended) return;
  suspended = true;
  try {
    await serial(async () => {
      const saved = await readDevice();
      if (!saved) return;
      if (saved.userId !== userId) throw new Error('Notification settings belong to another account.');
      const sessionToken = await accessToken();
      for (const token of saved.tokens) await unregister(token,sessionToken);
      await SecureStore.deleteItemAsync(DEVICE_KEY);
    });
    setStatus('available');
  } catch {
    setStatus('enabled','Could not turn off delivery alerts. Check your connection and try again.');
  } finally {suspended = false;}
}

/** Deactivate the device before the session is removed; never leave another user’s token active. */
export async function unregisterPushBeforeSignOut(userId:string | undefined) {
  if (Platform.OS !== 'android') return;
  suspended = true;
  generation++;
  try {
    await serial(async () => {
      const saved = await readDevice();
      if (!saved) return;
      if (userId && saved.userId !== userId) throw new Error('Notification settings belong to another account.');
      const sessionToken = await accessToken();
      for (const token of saved.tokens) await unregister(token,sessionToken);
      await SecureStore.deleteItemAsync(DEVICE_KEY);
    });
  } catch {
    suspended = false;
    throw new Error('Connect to the internet to turn off this device’s alerts before signing out.');
  }
}

/** Installs foreground, tap and token-rotation listeners for the signed-in account. */
export function startPushSession(userId:string, onReceived:() => void, onOpen:() => void) {
  const current = ++generation;
  suspended = false;
  const unsupported = supported();
  if (unsupported) {setStatus(unsupported);return () => {generation++;};}
  let active = true;
  let subscriptions: {remove:() => void}[] = [];
  void (async () => {
    try {
      const Notifications = notificationsModule();
      if (!active || current !== generation) return;
      Notifications.setNotificationHandler({handleNotification:async () => ({shouldShowBanner:true,shouldShowList:true,shouldPlaySound:true,shouldSetBadge:false})});
      subscriptions = [
        Notifications.addPushTokenListener(token => {if (active && !suspended && usePushStatus.getState().status === 'enabled' && token.type === 'android' && typeof token.data === 'string') void serial(() => register(userId,token.data as string,current)).catch(() => {if (active && !suspended && current === generation) setStatus('error','Could not update delivery alerts. Please try again.');});}),
        Notifications.addNotificationReceivedListener(() => {if (active) onReceived();}),
        Notifications.addNotificationResponseReceivedListener(() => {if (active) onOpen();}),
      ];
      const response = await Notifications.getLastNotificationResponseAsync();
      if (active && response) {await Notifications.clearLastNotificationResponseAsync();onOpen();}
      if (active) await synchronize(userId,current,false);
    } catch {if (active && current === generation) setStatus('error','Could not prepare delivery alerts. Please try again.');}
  })();
  return () => {active=false;if (generation === current) generation++;subscriptions.forEach(subscription => subscription.remove());};
}
