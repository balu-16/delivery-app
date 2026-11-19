import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Crypto from 'expo-crypto';
import { ApiError } from '../api/client';
import { customerDetailsApi } from '../api/customer';

/** Persist only a fingerprint and key, so an interrupted request can be retried safely. */
export async function sendSupportMessage(userId: string, token: string, body: string, ticketId: string | null): Promise<{id:string}> {
  const storageKey = `@dairydirect/support-request:${userId}:${ticketId ?? 'new'}`;
  const fingerprint = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, JSON.stringify({ticketId, body}));
  const stored = await AsyncStorage.getItem(storageKey);
  let key: string;
  if (stored) {
    let parsed: {fingerprint?: unknown; key?: unknown};
    try { parsed = JSON.parse(stored) as typeof parsed; } catch { throw new Error('SUPPORT_RECOVERY_REQUIRED'); }
    if (parsed.fingerprint !== fingerprint || typeof parsed.key !== 'string' || !parsed.key) throw new Error('SUPPORT_RECOVERY_REQUIRED');
    key = parsed.key;
  } else {
    key = Crypto.randomUUID();
    await AsyncStorage.setItem(storageKey, JSON.stringify({fingerprint, key}));
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const result = ticketId
      ? await customerDetailsApi.ticketMessage(token, ticketId, body, key, controller.signal)
      : await customerDetailsApi.createTicket(token, body, key, controller.signal);
    await AsyncStorage.removeItem(storageKey).catch(() => undefined);
    return result;
  } catch (error) {
    if (error instanceof ApiError && error.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 429) await AsyncStorage.removeItem(storageKey).catch(() => undefined);
    throw error;
  } finally { clearTimeout(timer); }
}

export function supportSendError(error: unknown): string {
  if (error instanceof Error && error.message === 'SUPPORT_RECOVERY_REQUIRED') return 'We’re checking if your message was sent.';
  if (error instanceof ApiError) {
    if (error.status === 401) return 'Sign in again to continue.';
    if (error.status === 429) return 'Too many requests right now.';
    // Definitive rejections (4xx except 408/429) are safe to explain directly;
    // anything ambiguous stays a checking message so the same key retries.
    if (error.status >= 400 && error.status < 500 && error.status !== 408) {
      return 'This message couldn’t be sent.';
    }
    return 'We’re checking if your message was sent.';
  }
  if (error instanceof TypeError || (error instanceof Error && error.name === 'AbortError')) {
    return 'We’re checking if your message was sent.';
  }
  return 'We’re checking if your message was sent.';
}
