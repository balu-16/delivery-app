import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Crypto from 'expo-crypto';
import { ApiError } from './api';

/** Retain only a random operation key: never persist customer codes or cash inputs. */
export async function performAction<T>(subject: string, entity: string, action: string, work: (key: string) => Promise<T>): Promise<T> {
  const storageKey = `dairydirect.partner.action.v1:${subject}:${entity}:${action}`;
  let key = await AsyncStorage.getItem(storageKey);
  if (!key) { key = Crypto.randomUUID(); await AsyncStorage.setItem(storageKey, key); }
  try {
    const result = await work(key);
    await AsyncStorage.removeItem(storageKey);
    return result;
  } catch (error) {
    if (error instanceof ApiError && error.status >= 400 && error.status < 500 &&
        ![408, 429].includes(error.status) && error.code !== 'IDEMPOTENCY_KEY_REUSED')
      await AsyncStorage.removeItem(storageKey);
    throw error;
  }
}
