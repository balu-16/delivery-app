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
export type Earning = { taskId: string; orderId: string; totalPaise: string; computedAt: string; basePaise: string; distancePaise: string; incentivePaise: string; tipPaise: string };
export type Notice = components['schemas']['NotificationViewDto'];
export type Ticket = { id: string; category: string; status: string; created_at: string };
export type UploadTarget = components['schemas']['UploadTargetResponseDto'];

export class ApiError extends Error {
  constructor(public readonly code: string, public readonly status: number) {
    super(readableError(code));
  }
}

/** Only messages created by the app are exposed to the user. */
export class UploadError extends Error {}

export function readableError(code: string): string {
  const messages: Record<string, string> = {
    BACKEND_CONFIGURATION: "The partner server address is not configured. Contact support.",
    BACKEND_DISCOVERY: "Could not find the local server. Connect to the development server over your local network and try again.",
    NETWORK_ERROR: "Unable to reach the server. Check your connection and try again.",
    INVALID_MEDIA: "The file could not be accepted. Choose a supported file that is 5 MB or smaller and try again.",
    RIDER_ENROLLMENT_REQUIRES_REVIEW: "Your account needs a manual review. Please contact support.",
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

type Options = { method?: "GET" | "POST" | "PATCH" | "DELETE"; body?: unknown; key?: string; idToken?: boolean; retry401?: boolean };
export async function request<T>(path: string, options: Options = {}): Promise<T> {
  if (!path.startsWith('/v1/rider/')) throw new Error('Invalid partner API path');
  const token = options.idToken ? await getIdToken() : await getAccessToken();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  let response: Response;
  try {
    response = await fetch(`${apiBase()}${path}`, {
      method: options.method ?? "GET", signal: controller.signal,
      headers: { Authorization: `Bearer ${token}`, ...(options.body !== undefined ? { "Content-Type": "application/json" } : {}), ...(options.key ? { "Idempotency-Key": options.key } : {}) },
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    });
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError("NETWORK_ERROR", 0);
  } finally { clearTimeout(timer); }
  if (response.status === 401 && !options.idToken && options.retry401 !== false) {
    await getAccessToken(true);
    return request<T>(path, { ...options, retry401: false });
  }
  const raw = await response.text();
  let data: unknown = null;
  if (raw) { try { data = JSON.parse(raw); } catch { if (response.ok) throw new ApiError("INVALID_RESPONSE", response.status); } }
  if (!response.ok) {
    const payload = data && typeof data === 'object' ? data as { code?: unknown } : null;
    throw new ApiError(typeof payload?.code === 'string' ? payload.code : `HTTP_${response.status}`, response.status);
  }
  return data as T;
}

const post = <T>(path: string, body?: unknown, key?: string) => request<T>(path, { method: "POST", body, key });
export const riderApi = {
  bootstrap: () => request<{ userId: string; status: Application['status']; groupPending: boolean }>("/v1/rider/auth/bootstrap", { method: "POST", idToken: true }),
  application: () => request<Application>("/v1/rider/onboarding"),
  onboardingStores: () => request<OnboardingStore[]>("/v1/rider/onboarding/stores"),
  selectOnboardingStore: (storeId: string) => post<void>("/v1/rider/onboarding/store", { storeId }),
  profile: (vehicleType: string, vehicleNo: string) => post<void>("/v1/rider/onboarding/profile", { vehicleType, vehicleNo }),
  documentTarget: (contentType: string, size: number) => post<UploadTarget>("/v1/rider/onboarding/documents/upload-url", { contentType, size }),
  document: (documentType: string, mediaId: string) => post<void>("/v1/rider/onboarding/documents", { documentType, mediaId }),
  status: () => request<RiderStatus>("/v1/rider/status"),
  online: () => post<void>("/v1/rider/status/online"),
  offline: () => post<void>("/v1/rider/status/offline"),
  break: (onBreak: boolean) => post<void>("/v1/rider/status/break", { onBreak }),
  heartbeat: () => post<void>("/v1/rider/heartbeat", {}),
  location: (points: { ts: string; lat: number; lng: number; accuracyM?: number; speedMps?: number; isMock?: boolean }[]) => post<{ accepted: number; rejected: { count: number; reasons: Record<string, number> } }>("/v1/rider/location", { points }),
  offers: () => request<{ items: Offer[] }>("/v1/rider/offers"),
  activeTasks: () => request<Page<Task>>("/v1/rider/tasks?scope=active"),
  history: (cursor?: string) => request<Page<HistoryTask>>(`/v1/rider/tasks?scope=history${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`),
  task: (id: string) => request<Task>(`/v1/rider/tasks/${encodeURIComponent(id)}`),
  accept: (id: string, key: string) => post<void>(`/v1/rider/offers/${encodeURIComponent(id)}/accept`, {}, key),
  decline: (id: string, key: string) => post<void>(`/v1/rider/offers/${encodeURIComponent(id)}/decline`, {}, key),
  taskAction: (id: string, action: string, body: unknown, key: string) => post<void>(`/v1/rider/tasks/${encodeURIComponent(id)}/${action}`, body, key),
  contact: (id: string) => request<{ contactName: string; contactPhone: string } | null>(`/v1/rider/tasks/${encodeURIComponent(id)}/contact`),
  podTarget: (id: string, contentType: string, size: number) => post<UploadTarget>(`/v1/rider/tasks/${encodeURIComponent(id)}/pod`, { contentType, size }),
  podComplete: (id: string, mediaId: string) => post<void>(`/v1/rider/tasks/${encodeURIComponent(id)}/pod/${encodeURIComponent(mediaId)}/complete`),
  dashboard: () => request<{ todayDeliveries: number; todayEarningsPaise: string }>("/v1/rider/dashboard"),
  earnings: (cursor?: string) => request<Page<Earning>>(`/v1/rider/earnings${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`),
  cash: () => request<{ cashInHandPaise: string; limitPaise: string | null }>("/v1/rider/cash-in-hand"),
  notifications: () => request<Page<Notice>>("/v1/rider/notifications"),
  readNotifications: () => post<void>("/v1/rider/notifications/read-all"),
  registerDevice: (token: string) => post<void>("/v1/rider/device-tokens", { token, platform: "ANDROID", identifierType: "FCM_TOKEN" }),
  unregisterDevice: (token: string) => request<void>("/v1/rider/device-tokens", { method: "DELETE", body: { token } }),
  tickets: (cursor?: string) => request<Page<Ticket>>(`/v1/rider/tickets${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`),
  ticket: (id: string) => request<{ messages: { id: string; body: string; created_at: string }[] }>(`/v1/rider/tickets/${encodeURIComponent(id)}`),
  createTicket: (category: string, body: string, key: string) => post<{ id: string }>("/v1/rider/tickets", { category, body }, key),
  ticketMessage: (id: string, body: string, key: string) => post<void>(`/v1/rider/tickets/${encodeURIComponent(id)}/messages`, { body }, key),
};

export async function uploadFile(target: UploadTarget, file: { uri: string; name: string; mimeType: string; webFile?: Blob }): Promise<void> {
  try {
    const url = new URL(target.url, `${apiBase()}/`);
    const api = new URL(apiBase());
    if (url.protocol !== 'https:' && !(__DEV__ && url.origin === api.origin)) throw new Error('Invalid upload target');
    const localAuthorization = target.fields.authorization;
    if (localAuthorization && url.origin !== api.origin) throw new Error('Invalid local upload target');

    let status: number;
    if (Platform.OS !== 'web') {
      // Expo's fetch does not support React Native's { uri, name, type } FormData parts.
      // Native uploads put all signed fields before the file, as required by S3.
      const result = await new ExpoFile(file.uri).upload(url.toString(), localAuthorization
        ? { httpMethod: 'PUT', uploadType: UploadType.BINARY_CONTENT, headers: { Authorization: localAuthorization, 'Content-Type': 'application/octet-stream' } }
        : { httpMethod: 'POST', uploadType: UploadType.MULTIPART, fieldName: 'file', mimeType: file.mimeType, parameters: target.fields });
      status = result.status;
    } else {
      let blob = file.webFile;
      if (!blob) {
        const selected = await fetch(file.uri);
        if (!selected.ok) throw new Error('Cannot read selected file');
        blob = await selected.blob();
      }
      let response: Response;
      if (localAuthorization) {
        response = await fetch(url.toString(), { method: 'PUT', headers: { Authorization: localAuthorization, 'Content-Type': 'application/octet-stream' }, body: blob });
      } else {
        const form = new FormData();
        Object.entries(target.fields).forEach(([key, value]) => form.append(key, value));
        form.append('file', new Blob([blob], { type: file.mimeType }), file.name);
        response = await fetch(url.toString(), { method: 'POST', body: form });
      }
      status = response.status;
    }
    if (status === 403 || status === 410) throw new UploadError('The upload expired or was rejected. Please try again.');
    if (status < 200 || status >= 300) throw new Error('Upload failed');
  } catch (failure) {
    // Do not reveal signed URLs, response bodies, local paths or provider errors.
    if (failure instanceof UploadError || failure instanceof ApiError) throw failure;
    throw new UploadError('Could not upload the file. Check your connection and try again.');
  }
}
