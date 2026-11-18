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
  if (error instanceof Error && error.message === 'SUPPORT_RECOVERY_REQUIRED') return 'An earlier message may still be processing. Check your support requests, or retry that same message before sending a different one.';
  if (error instanceof ApiError && error.status === 401) return 'Your session has expired. Sign in again, then retry your message.';
  if (error instanceof ApiError && error.status === 429) return 'Too many requests right now. Please wait a little and retry.';
  const reference = error instanceof ApiError && error.traceId && /^[a-zA-Z0-9-]{1,80}$/.test(error.traceId) ? ` Reference: ${error.traceId}` : '';
  return `We could not confirm that your message was sent. Check your connection and retry the same message safely.${reference}`;
}
