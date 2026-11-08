import { cert, getApps, initializeApp } from 'firebase-admin/app';
import { getMessaging, type MulticastMessage, type BatchResponse } from 'firebase-admin/messaging';
import type {
  PushPayload,
  PushPort,
  PushTokenResult,
} from '../../modules/notifications/contracts/notifications.js';

const MAX_BATCH = 500;
const PERMANENT_CODES = new Set([
  'messaging/invalid-argument',
  'messaging/mismatched-credential',
  'messaging/authentication-error',
  'messaging/invalid-package-name',
  'messaging/invalid-credential',
  'messaging/third-party-auth-error',
  'messaging/invalid-payload',
  'messaging/invalid-data-payload-key',
  'messaging/payload-size-limit-exceeded',
]);
const INVALID_TOKEN_CODES = new Set([
  'messaging/registration-token-not-registered',
  'messaging/invalid-registration-token',
  'messaging/unregistered',
]);
function retryAfterMs(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const value = error as {
    retryAfter?: unknown;
    headers?: Record<string, unknown>;
    response?: { headers?: Record<string, unknown> };
  };
  const headers = value.response?.headers ?? value.headers;
  const raw =
    value.retryAfter ??
    (typeof headers?.['get'] === 'function'
      ? (headers['get'] as (key: string) => unknown)('retry-after')
      : headers?.['retry-after']);
  if (typeof raw !== 'string' && typeof raw !== 'number') return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(String(raw));
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}

/**
 * FCM adapter (firebase-admin). One multicast per ≤500-token batch, one
 * attempt per call; the durable delivery row owns bounded retries. Invalid
 * registrations are reported per token so the pipeline deactivates them.
 */
export class FcmPush implements PushPort {
  private readonly messaging: {
    sendEachForMulticast(message: MulticastMessage): Promise<BatchResponse>;
  };
  constructor(
    serviceAccountJson: string,
    messaging?: { sendEachForMulticast(message: MulticastMessage): Promise<BatchResponse> },
  ) {
    const credentials = parseServiceAccount(serviceAccountJson);
    if (messaging) {
      this.messaging = messaging;
    } else {
      const existing = getApps().find((app) => app.name === 'delivery-push');
      const app = existing ?? initializeApp({ credential: cert(credentials) }, 'delivery-push');
      this.messaging = getMessaging(app);
    }
  }
  async send(
    tokens: readonly string[],
    payload: PushPayload,
    identifierType: 'FCM_TOKEN' | 'FID' = 'FCM_TOKEN',
  ): Promise<PushTokenResult[]> {
    if (!tokens.length || tokens.length > MAX_BATCH) throw new Error('INVALID_INPUT');
    let response: import('firebase-admin/messaging').BatchResponse;
    try {
      // firebase-admin exposes no per-call timeout; the HTTP agent timeout is
      // the process default and the durable row bounds the retry window.
      response = await withTimeout(
        this.messaging.sendEachForMulticast({
          tokens: identifierType === 'FID' ? [] : [...tokens],
          ...(identifierType === 'FID' ? { fids: [...tokens] } : {}),
          notification: {
            title: payload.title,
            body: payload.body,
            ...(payload.imageUrl ? { imageUrl: payload.imageUrl } : {}),
          },
          data: Object.fromEntries(
            Object.entries({
              ...payload.data,
              ...(payload.deepLink ? { link: payload.deepLink } : {}),
              ...(payload.deepLink ? { clickAction: payload.deepLink } : {}),
            }).map(([key, value]) => [key, String(value)]),
          ),
          android: {
            priority: payload.priority === 'HIGH' ? 'high' : 'normal',
            collapseKey: payload.data['collapseKey'],
            notification: { channelId: 'default' },
          },
          webpush: {
            headers: { TTL: '86400' },
            ...(payload.deepLink?.startsWith('https://')
              ? { fcmOptions: { link: payload.deepLink } }
              : {}),
          },
          apns: {
            headers: {
              'apns-priority': payload.priority === 'HIGH' ? '10' : '5',
              'apns-collapse-id': payload.data['collapseKey'] ?? '',
            },
          },
        }),
        30_000,
      );
    } catch (error: unknown) {
      // Whole-batch transport failure (auth/network); typed, PII-free code.
      const wrapped = new Error('ExternalServiceUnavailable');
      Object.assign(wrapped, { retryAfterMs: retryAfterMs(error) });
      throw wrapped;
    }
    return response.responses.map((result, index) => ({
      token: tokens[index]!,
      ok: result.success,
      invalidToken: !result.success && INVALID_TOKEN_CODES.has(result.error?.code ?? ''),
      retryable:
        result.success ||
        (!PERMANENT_CODES.has(result.error?.code ?? '') &&
          !INVALID_TOKEN_CODES.has(result.error?.code ?? '')),
      ...(retryAfterMs(result.error) !== undefined
        ? { retryAfterMs: retryAfterMs(result.error) }
        : {}),
      messageId: result.success ? (result.messageId ?? null) : null,
      error: result.success ? null : (result.error?.code ?? 'PUSH_FAILED'),
    }));
  }
}

function parseServiceAccount(json: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(json);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      throw new Error('not an object');
    return parsed as Record<string, unknown>;
  } catch (error) {
    throw new Error('INVALID_FCM_SERVICE_ACCOUNT', { cause: error });
  }
}

async function withTimeout<T>(work: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('PROVIDER_TIMEOUT')), milliseconds);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
