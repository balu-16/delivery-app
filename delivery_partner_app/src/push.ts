import Constants from 'expo-constants';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';
import { create } from 'zustand';
import { riderApi } from './api';

type DeviceRecord = { userId: string; tokens: string[]; primary: string };
type PushStatus = 'available' | 'enabled' | 'unsupported' | 'busy' | 'error';
type NotificationsModule = typeof import('expo-notifications');
const KEY = 'dairydirect.partner.push-device.v1';
let generation = 0;
let suspended = false;
let queue: Promise<void> = Promise.resolve();
export const usePush = create<{ status: PushStatus; message: string }>(() => ({ status: 'available', message: '' }));
const setStatus = (status: PushStatus, message = '') => usePush.setState({ status, message });
function supported() { return Platform.OS === 'android' && Constants.appOwnership !== 'expo'; }
function notifications(): NotificationsModule {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('expo-notifications') as NotificationsModule;
}
function serial<T>(work: () => Promise<T>): Promise<T> {
  const result = queue.then(work, work);
  queue = result.then(() => undefined, () => undefined);
  return result;
}
async function readDevice(): Promise<DeviceRecord | null> {
  const raw = await SecureStore.getItemAsync(KEY);
  if (!raw) return null;
  const value = JSON.parse(raw) as DeviceRecord;
  if (typeof value.userId !== 'string' || !Array.isArray(value.tokens) || !value.tokens.length ||
      value.tokens.some((token) => typeof token !== 'string' || token.length < 16) || !value.tokens.includes(value.primary))
    throw new Error('Invalid notification settings');
  return value;
}
async function register(userId: string, token: string, expected: number) {
  if (suspended || expected !== generation) return;
  if (token.length < 16 || token.length > 4096 || /\s/.test(token)) throw new Error('Invalid device token');
  const previous = await readDevice();
  if (previous && previous.userId !== userId) throw new Error('Notification settings belong to another account');
  const record = { userId, primary: token, tokens: [...new Set([...(previous?.tokens ?? []), token])] };
  await SecureStore.setItemAsync(KEY, JSON.stringify(record));
  if (suspended || expected !== generation) return;
  await riderApi.registerDevice(token);
  const remaining = [token];
  for (const old of record.tokens) {
    if (old === token) continue;
    try { await riderApi.unregisterDevice(old); } catch { remaining.push(old); }
  }
  await SecureStore.setItemAsync(KEY, JSON.stringify({ ...record, tokens: remaining }));
  if (!suspended && expected === generation) setStatus('enabled');
}
async function synchronize(userId: string, expected: number, ask: boolean) {
  return serial(async () => {
    if (suspended || expected !== generation) return;
    if (!supported()) { setStatus('unsupported'); return; }
    setStatus('busy');
    try {
      const saved = await readDevice();
      if (!ask && (!saved || saved.userId !== userId)) { setStatus('available'); return; }
      const module = notifications();
      await module.setNotificationChannelAsync('default', { name: 'Delivery updates', importance: module.AndroidImportance.HIGH });
      let permission = await module.getPermissionsAsync();
      if (!permission.granted && ask) permission = await module.requestPermissionsAsync();
      if (!permission.granted) {
        if (saved?.userId === userId) {
          for (const old of saved.tokens) await riderApi.unregisterDevice(old);
          await SecureStore.deleteItemAsync(KEY);
        }
        setStatus('available', 'Allow notifications in device settings to receive offer alerts.');
        return;
      }
      const native = await module.getDevicePushTokenAsync();
      if (native.type !== 'android' || typeof native.data !== 'string') throw new Error('No Android token');
      await register(userId, native.data, expected);
    } catch {
      if (!suspended && expected === generation) setStatus('error', 'Could not enable delivery alerts. Check your connection and build configuration.');
    }
  });
}
export function enablePush(userId: string) { return synchronize(userId, generation, true); }
export async function unregisterPush(userId: string) {
  if (Platform.OS !== 'android') return;
  suspended = true;
  generation++;
  try {
    await serial(async () => {
      const saved = await readDevice();
      if (!saved) return;
      if (saved.userId !== userId) throw new Error('Notification settings belong to another account');
      for (const token of saved.tokens) await riderApi.unregisterDevice(token);
      await SecureStore.deleteItemAsync(KEY);
    });
    setStatus('available');
  } catch {
    suspended = false;
    throw new Error('Connect to the internet to turn off this device’s delivery alerts before signing out.');
  }
}
export function startPush(userId: string, onUpdate: () => void, onOpen: () => void) {
  const current = ++generation;
  suspended = false;
  if (!supported()) { setStatus('unsupported'); return () => { generation++; }; }
  let active = true;
  let listeners: { remove: () => void }[] = [];
  void (async () => {
    try {
      const module = notifications();
      module.setNotificationHandler({ handleNotification: async () => ({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: true, shouldSetBadge: false }) });
      listeners = [
        module.addPushTokenListener((token) => {
          if (active && !suspended && usePush.getState().status === 'enabled' && token.type === 'android' && typeof token.data === 'string')
            void serial(() => register(userId, token.data as string, current)).catch(() => setStatus('error', 'Could not update delivery alerts.'));
        }),
        module.addNotificationReceivedListener(() => { if (active) onUpdate(); }),
        module.addNotificationResponseReceivedListener(() => { if (active) onOpen(); }),
      ];
      const response = await module.getLastNotificationResponseAsync();
      if (active && response) { await module.clearLastNotificationResponseAsync(); onOpen(); }
      if (active) await synchronize(userId, current, false);
    } catch { if (active) setStatus('error', 'Could not prepare delivery alerts.'); }
  })();
  return () => { active = false; if (generation === current) generation++; listeners.forEach((listener) => listener.remove()); };
}
