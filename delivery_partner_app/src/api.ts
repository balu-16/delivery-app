import { Platform } from "react-native";
import { File as ExpoFile, UploadType } from 'expo-file-system';
import { developmentHost, resolveApiAddress } from './apiAddress';
import { getAccessToken, getIdToken } from "./auth/session";
import type { components } from './rider-api.generated';

export type Application = components['schemas']['RiderApplicationDto'];
export type OnboardingStore = components['schemas']['RiderOnboardingStoreDto'];
export type Offer = components['schemas']['OfferView'];
export type Task = components['schemas']['RiderActiveTaskView'];
export type HistoryTask = components['schemas']['RiderTaskHistoryView'];
export type Page<T> = { items: T[]; nextCursor: string | null };
export type RiderStatus = components['schemas']['RiderMeView'];
export type Earning = { taskId: string; orderId: string; totalPaise: string; computedAt: string; basePaise: string; distancePaise: string; incentivePaise: string; tipPaise: string; distanceMetres?: number | null; distancePending?: boolean };
export type Notice = components['schemas']['NotificationViewDto'];
export type Ticket = { id: string; category: string; status: string; created_at: string };
export type TaskHistoryDetail = { id: string; taskId: string; orderId: string; orderNumber: string; attemptNo: number; assignedAt: string; status: string; pickupAt: string | null; arrivedStoreAt: string | null; arrivedCustomerAt: string | null; deliveredAt: string | null; failureReason: string | null; earnings: { totalPaise: string | null; basePaise: string | null; distancePaise: string | null; incentivePaise: string | null; tipPaise: string | null; distanceMetres: number | null; distancePending: boolean; computedAt: string | null } };
export type UploadTarget = Omit<components['schemas']['UploadTargetResponseDto'], 'expiresAt'> & {
  expiresAt?: string;
};
export interface AppContentItem {
  slot: 'CUSTOMER_HOME_BANNER' | 'CUSTOMER_OFFERS_CARD' | 'RIDER_HOME_ANNOUNCEMENT' | 'CUSTOMER_HELP' | 'RIDER_HELP';
  state: 'UNSET' | 'VISIBLE' | 'DISABLED' | 'INACTIVE';
  locale: 'en' | 'hi' | 'te' | null;
  title: string | null; body: string | null;
  imageMediaId: string | null; imageUrl: string | null;
  destination: string | null; version: number | null;
}
type OnboardingApplication = Application & { maxDocumentBytes?: number };
type OnboardingSave = components['schemas']['RiderOnboardingUpdatedDto'] | null | undefined;
type RequestBudget = { signal?: AbortSignal; timeoutMs?: number };
type SupportRead = RequestBudget & { onboarding?: boolean };

export class ApiError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
    public readonly traceId?: string,
    public readonly requestId?: string,
  ) {
    super(readableError(code));
  }
}

/** Only messages created by the app are exposed to the user. */
export class UploadError extends Error {
  constructor(message: string, public readonly kind: 'retryable' | 'expired' | 'rejected' | 'busy' = 'rejected') {
    super(message);
  }
}

export function readableError(code: string): string {
  const messages: Record<string, string> = {
    BACKEND_CONFIGURATION: "The partner server address is not configured. Contact support.",
    BACKEND_DISCOVERY: "Could not find the local server. Connect to the development server over your local network and try again.",
    NETWORK_ERROR: "Unable to reach the server. Check your connection and try again.",
    UPLOAD_NOT_RECEIVED: 'Upload the file first.',
    UPLOAD_PROCESSING: 'The upload is still being confirmed.',
    UPLOAD_EXPIRED: 'The upload expired.',
    PROFILE_NOT_INITIALIZED: 'Your partner application is still being prepared.',
    INVALID_MEDIA: "The file could not be accepted. Choose a supported file that is 5 MB or smaller and try again.",
    RIDER_ENROLLMENT_REQUIRES_REVIEW: "We couldn’t start your partner application because of an account conflict. Contact support for help signing in.",
    ROLE_CONFLICT: "This account belongs to a different app. Use a separate partner account.",
    RIDER_STATE_INVALID: "Your application is already under review. Refresh its status.",
    EMAIL_NOT_VERIFIED: "Verify your email before continuing.",
    ACCOUNT_DISABLED: "This account is unavailable. Please contact support.",
    RIDER_NOT_APPROVED: "Your application must be approved before you can work.",
    RIDER_OFFLINE: "Go online before starting this action.",
    OFFER_EXPIRED: "This offer has expired.",
    OFFER_NO_LONGER_AVAILABLE: "This offer is no longer available.",
    RIDER_AT_CAPACITY: "You already have the maximum number of active deliveries.",
    CASH_LIMIT_EXCEEDED: "Your cash-in-hand limit prevents accepting this order.",
    HANDOVER_NOT_VERIFIED: "The store must verify your handover code before pickup.",
    TASK_STATE_INVALID: "This delivery has changed. Refresh and check its current status.",
    RESOURCE_NOT_FOUND: "This delivery is no longer assigned to you.",
    DELIVERY_CODE_INVALID: "The delivery code is incorrect.",
    DELIVERY_CODE_LOCKED: "The delivery code is locked. Contact support.",
    COD_NOT_COLLECTED: "Record the cash collected before completing the delivery.",
    COD_AMOUNT_MISMATCH: "The cash amount does not match. Contact support before completing delivery.",
    DELIVERY_WAIT_REQUIRED: "Wait for the required time before reporting the customer unreachable.",
    DELIVERY_CONTACT_ATTEMPTS_REQUIRED: "Record the required contact attempts first.",
    ADMIN_RESOLUTION_REQUIRED: "This issue needs an administrator to resolve it.",
    IDEMPOTENCY_KEY_REUSED: "This action has already been submitted with different details. Refresh the delivery.",
  };
  return messages[code] ?? "Could not complete the request. Please try again.";
}

export function apiBase(): string {
  try {
    return resolveApiAddress({ configuredUrl: process.env.EXPO_PUBLIC_API_URL, development: __DEV__,
      developmentHost: __DEV__ ? developmentHost() : undefined, developmentPort: process.env.EXPO_PUBLIC_API_PORT });
  } catch (error) {
    throw new ApiError(error instanceof Error && error.message === 'BACKEND_DISCOVERY' ? 'BACKEND_DISCOVERY' : 'BACKEND_CONFIGURATION', 0);
  }
}

type Options = RequestBudget & {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  key?: string;
  idToken?: boolean;
  retry401?: boolean;
};

function requestBudget(signal: AbortSignal | undefined, timeoutMs: number) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal?.aborted) abort();
  else signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, timeoutMs);
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    },
  };
}

function safeReference(value: unknown): string | undefined {
  return typeof value === 'string' && /^[\w-]{1,80}$/.test(value) ? value : undefined;
}

export async function request<T>(path: string, options: Options = {}): Promise<T> {
  if (!path.startsWith('/v1/rider/')) throw new Error('Invalid partner API path');
  const url = `${apiBase()}${path}`;
  const budget = requestBudget(options.signal, options.timeoutMs ?? 15000);
  try {
    for (let attempt = 0; ; attempt++) {
      if (budget.signal.aborted) throw new ApiError('NETWORK_ERROR', 0);
      const token = options.idToken ? await getIdToken() : await getAccessToken(attempt > 0);
      if (budget.signal.aborted) throw new ApiError('NETWORK_ERROR', 0);
      const response = await fetch(url, {
        method: options.method ?? 'GET',
        signal: budget.signal,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...(options.key ? { 'Idempotency-Key': options.key } : {}),
        },
        ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
      });
      const raw = await response.text();
      if (budget.signal.aborted) throw new ApiError('NETWORK_ERROR', 0);
      if (response.status === 401 && attempt === 0 && !options.idToken && options.retry401 !== false)
        continue;
      const requestId = safeReference(response.headers?.get?.('x-request-id'));
      let data: unknown = null;
      if (raw) {
        try { data = JSON.parse(raw); }
        catch { if (response.ok) throw new ApiError('INVALID_RESPONSE', response.status, undefined, requestId); }
      }
      if (!response.ok) {
        const payload = data && typeof data === 'object' ? data as { code?: unknown; traceId?: unknown } : null;
        const code = typeof payload?.code === 'string' ? payload.code : `HTTP_${response.status}`;
        throw new ApiError(code, response.status, safeReference(payload?.traceId), requestId);
      }
      return data as T;
    }
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError('NETWORK_ERROR', 0);
  } finally {
    budget.dispose();
  }
}

const post = <T>(path: string, body?: unknown, key?: string, budget?: RequestBudget) =>
  request<T>(path, { method: 'POST', body, key, ...budget });
const supportPath = (onboarding?: boolean) => onboarding ? '/v1/rider/onboarding/tickets' : '/v1/rider/tickets';

export const riderApi = {
  bootstrap: (budget?: RequestBudget) => request<{ userId: string; status: Application['status']; groupPending: boolean }>("/v1/rider/auth/bootstrap", { method: "POST", idToken: true, ...budget }),
  application: (budget?: RequestBudget) => request<OnboardingApplication>("/v1/rider/onboarding", budget),
  onboardingStores: () => request<OnboardingStore[]>("/v1/rider/onboarding/stores"),
  selectOnboardingStore: (storeId: string, budget?: RequestBudget) => post<OnboardingSave>("/v1/rider/onboarding/store", { storeId }, undefined, budget),
  profile: (vehicleType: string, vehicleNo: string, budget?: RequestBudget) => post<OnboardingSave>("/v1/rider/onboarding/profile", { vehicleType, vehicleNo }, undefined, budget),
  documentTarget: (contentType: string, size: number, budget?: RequestBudget) => post<UploadTarget>("/v1/rider/onboarding/documents/upload-url", { contentType, size }, undefined, budget),
  document: (documentType: string, mediaId: string, signal?: AbortSignal) => post<OnboardingSave>("/v1/rider/onboarding/documents", { documentType, mediaId }, undefined, { timeoutMs: 35_000, signal }),
  status: (budget?: RequestBudget) => request<RiderStatus>("/v1/rider/status", budget),
  online: () => post<void>("/v1/rider/status/online"),
  offline: () => post<void>("/v1/rider/status/offline"),
  break: (onBreak: boolean) => post<void>("/v1/rider/status/break", { onBreak }),
  heartbeat: () => post<void>("/v1/rider/heartbeat", {}),
  location: (points: { ts: string; lat: number; lng: number; accuracyM?: number; speedMps?: number; isMock?: boolean }[]) => post<{ accepted: number; rejected: { count: number; reasons: Record<string, number> } }>("/v1/rider/location", { points }),
  offers: (budget?: RequestBudget) => request<{ items: Offer[] }>("/v1/rider/offers", budget),
  activeTasks: (budget?: RequestBudget) => request<Page<Task>>("/v1/rider/tasks?scope=active", budget),
  history: (cursor?: string, budget?: RequestBudget) => request<Page<HistoryTask>>(`/v1/rider/tasks?scope=history${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`, budget),
  task: (id: string, budget?: RequestBudget) => request<Task>(`/v1/rider/tasks/${encodeURIComponent(id)}`, budget),
  taskHistory: (id: string, attemptNo?: number, budget?: RequestBudget) => request<TaskHistoryDetail>(`/v1/rider/task-history/${encodeURIComponent(id)}${attemptNo !== undefined ? `?attemptNo=${attemptNo}` : ""}`, budget),
  offer: async (id: string) => {
    // No single-offer server read exists; reuse the scoped offers list.
    const page = await riderApi.offers();
    const found = page.items.find((item) => item.offerId === id);
    if (!found) throw new ApiError("RESOURCE_NOT_FOUND", 404);
    // Authoritative expiry check: the list only contains live offers, but the
    // offer may have expired between list and detail navigation.
    if (Date.parse(found.expiresAt) <= Date.now()) throw new ApiError("OFFER_EXPIRED", 409);
    return found;
  },
  accept: (id: string, key: string) => post<void>(`/v1/rider/offers/${encodeURIComponent(id)}/accept`, {}, key),
  decline: (id: string, key: string) => post<void>(`/v1/rider/offers/${encodeURIComponent(id)}/decline`, {}, key),
  taskAction: (id: string, action: string, body: unknown, key: string) => post<void>(`/v1/rider/tasks/${encodeURIComponent(id)}/${action}`, body, key),
  contact: (id: string) => request<{ contactName: string; contactPhone: string } | null>(`/v1/rider/tasks/${encodeURIComponent(id)}/contact`),
  podTarget: (id: string, contentType: string, size: number, budget?: RequestBudget) => post<UploadTarget>(`/v1/rider/tasks/${encodeURIComponent(id)}/pod`, { contentType, size }, undefined, budget),
  podComplete: (id: string, mediaId: string, signal?: AbortSignal) => post<void>(`/v1/rider/tasks/${encodeURIComponent(id)}/pod/${encodeURIComponent(mediaId)}/complete`, undefined, undefined, { timeoutMs: 35_000, signal }),
  dashboard: (budget?: RequestBudget) => request<{ todayDeliveries: number; todayEarningsPaise: string }>("/v1/rider/dashboard", budget),
  earnings: (cursor?: string, budget?: RequestBudget) => request<Page<Earning>>(`/v1/rider/earnings${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`, budget),
  cash: (budget?: RequestBudget) => request<{ cashInHandPaise: string; limitPaise: string | null }>("/v1/rider/cash-in-hand", budget),
  notifications: (budget?: RequestBudget) => request<Page<Notice>>("/v1/rider/notifications", budget),
  appContent: (locale?: string, budget?: RequestBudget) => request<AppContentItem[]>(`/v1/rider/app-content${locale ? `?locale=${encodeURIComponent(locale)}` : ""}`, budget),
  readNotifications: () => post<void>("/v1/rider/notifications/read-all"),
  readNotification: (id: string) => post<void>(`/v1/rider/notifications/${encodeURIComponent(id)}/read`),
  registerDevice: (token: string) => post<void>("/v1/rider/device-tokens", { token, platform: "ANDROID", identifierType: "FCM_TOKEN" }),
  unregisterDevice: (token: string) => request<void>("/v1/rider/device-tokens", { method: "DELETE", body: { token } }),
  tickets: (cursor?: string, options?: SupportRead) => request<Page<Ticket>>(
    `${supportPath(options?.onboarding)}${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`, options,
  ),
  ticket: (id: string, options?: SupportRead) => request<{ messages: { id: string; body: string; created_at: string }[] }>(
    `${supportPath(options?.onboarding)}/${encodeURIComponent(id)}`, options,
  ),
  createTicket: (category: string, body: string, key: string) => category === 'ONBOARDING'
    ? post<{ id: string }>(supportPath(true), { body }, key)
    : post<{ id: string }>(supportPath(), { category, body }, key),
  ticketMessage: (id: string, body: string, key: string, onboarding?: boolean) =>
    post<void>(`${supportPath(onboarding)}/${encodeURIComponent(id)}/messages`, { body }, key),
};

const TRANSFER_TIMEOUT_MS = 120_000;

export async function uploadFile(
  target: UploadTarget,
  file: { uri: string; name: string; mimeType: string; webFile?: Blob },
  options: { signal?: AbortSignal; onProgress?: (progress: number) => void } = {},
): Promise<void> {
  const expires = target.expiresAt ? Date.parse(target.expiresAt) : Infinity;
  const remaining = Number.isNaN(expires) ? TRANSFER_TIMEOUT_MS : Math.min(TRANSFER_TIMEOUT_MS, expires - Date.now());
  if (remaining <= 0) throw new UploadError('The upload expired.', 'expired');
  const budget = requestBudget(options.signal, remaining);
  try {
    const base = new URL(apiBase());
    const url = new URL(target.url, base);
    const authorization = target.fields.authorization;
    if (
      url.username || url.password ||
      (url.protocol !== 'https:' && !(__DEV__ && url.origin === base.origin)) ||
      (authorization && url.origin !== base.origin)
    ) throw new UploadError('The upload address is invalid. Please try again.');
    if (budget.signal.aborted) throw new UploadError('The upload was interrupted.', 'retryable');

    const local = {
      httpMethod: 'PUT' as const,
      uploadType: UploadType.BINARY_CONTENT,
      headers: { Authorization: authorization!, 'Content-Type': 'application/octet-stream' },
    };
    let status: number;
    if (Platform.OS === 'web') {
      const blob = file.webFile ?? await (await fetch(file.uri, { signal: budget.signal })).blob();
      let body: Blob | FormData = blob;
      if (!authorization) {
        const form = new FormData();
        for (const [key, value] of Object.entries(target.fields)) form.append(key, value);
        form.append('file', new Blob([blob], { type: file.mimeType }), file.name);
        body = form;
      }
      const result = await fetch(url.toString(), {
        method: authorization ? 'PUT' : 'POST',
        headers: authorization ? local.headers : undefined,
        body,
        signal: budget.signal,
        credentials: 'omit',
        redirect: 'error',
      });
      status = result.status;
    } else {
      const native = new ExpoFile(file.uri);
      if (typeof native.createUploadTask !== 'function')
        throw new UploadError('Update the partner app to upload documents.');
      let lastReport = 0;
      const task = native.createUploadTask(url.toString(), {
        ...(authorization ? local : {
          httpMethod: 'POST', uploadType: UploadType.MULTIPART, fieldName: 'file',
          mimeType: file.mimeType, parameters: target.fields,
        }),
        signal: budget.signal,
        onProgress: ({ bytesSent, totalBytes }) => {
          const now = Date.now();
          if (!budget.signal.aborted && totalBytes > 0 && (now - lastReport >= 200 || bytesSent >= totalBytes)) {
            lastReport = now;
            options.onProgress?.(Math.min(1, bytesSent / totalBytes));
          }
        },
      });
      status = (await task.uploadAsync()).status;
    }

    if (status === 410 || (status === 403 && Date.now() >= expires))
      throw new UploadError('The upload expired.', 'expired');
    if (status === 408 || status === 429 || status >= 500)
      throw new UploadError('Couldn’t upload this file. Tap Retry.', 'retryable');
    if (status < 200 || status >= 300)
      throw new UploadError('The upload was rejected. Tap Retry.');
  } catch (error) {
    if (error instanceof UploadError || error instanceof ApiError) throw error;
    if (budget.signal.aborted && Date.now() >= expires) throw new UploadError('The upload expired.', 'expired');
    throw new UploadError('Couldn’t upload this file. Tap Retry.', 'retryable');
  } finally {
    budget.dispose();
  }
}
