import { refreshSession, type Tokens } from './auth';
import type { components } from './store-api.generated';

export type StoreProfile = components['schemas']['StoreResponseDto'];
export type Rider = components['schemas']['RiderApplicationListItemDto'];
export type Application = components['schemas']['RiderApplicationDto'];
export type PickItem = components['schemas']['PickItemView'];
export type PickTask = Pick<
  components['schemas']['PickTaskView'],
  'id' | 'orderId' | 'storeId' | 'status' | 'assignedTo' | 'slaDueAt' | 'items'
> & { orderStatus?: string; itemCount?: number };
export type StoreOrder = components['schemas']['StoreOrderSummaryView'];
export type Page<T> = { items: T[]; nextCursor: string | null };

const errors: Record<string, string> = {
  FORBIDDEN: 'This account cannot access this store or action.',
  RESOURCE_NOT_FOUND: 'This item is no longer available. Refresh and try again.',
  DOCUMENT_STATE_INVALID: 'This document has changed. Refresh the application and try again.',
  REVIEW_REASON_REQUIRED: 'Enter a reason when rejecting a document.',
  PICK_TASK_STATE_INVALID: 'This task has changed. Refresh and try again.',
  NOT_TASK_OWNER: 'This task is assigned to another manager.',
  PICKER_AT_CAPACITY: 'Complete an active task before claiming another.',
  IDEMPOTENCY_KEY_REUSED:
    'This action was submitted with different details. Refresh and try again.',
};

export class StoreApi {
  private refresh: Promise<Tokens> | null = null;
  constructor(private tokens: Tokens) {}
  getTokens() {
    return this.tokens;
  }
  private async token(force = false): Promise<string> {
    if (!force && Date.now() < this.tokens.expiresAt - 60_000) return this.tokens.accessToken;
    this.refresh ??= refreshSession(this.tokens).finally(() => {
      this.refresh = null;
    });
    this.tokens = await this.refresh;
    return this.tokens.accessToken;
  }
  async request<T>(
    path: string,
    options: { method?: 'GET' | 'POST'; body?: unknown; key?: string } = {},
    retry = true,
  ): Promise<T> {
    if (!path.startsWith('/v1/store/')) throw new Error('Invalid store request.');
    const rawBase = (import.meta.env.VITE_API_URL as string | undefined)?.trim();
    if (!rawBase) throw new Error('The store API is not configured.');
    let base: URL;
    try {
      base = new URL(rawBase);
    } catch {
      throw new Error('The store API address is invalid.');
    }
    if (
      !['http:', 'https:'].includes(base.protocol) ||
      base.username ||
      base.password ||
      base.search ||
      base.hash ||
      (import.meta.env.PROD && base.protocol !== 'https:')
    )
      throw new Error('The store API address is invalid.');
    const token = await this.token();
    let response: Response;
    try {
      response = await fetch(`${base.toString().replace(/\/$/, '')}${path}`, {
        method: options.method ?? 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
          ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...(options.key ? { 'Idempotency-Key': options.key } : {}),
        },
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      });
    } catch {
      throw new Error('Cannot reach the store server. Check your connection.');
    }
    if (response.status === 401 && retry) {
      await this.token(true);
      return this.request(path, options, false);
    }
    const raw = await response.text();
    let data: unknown = null;
    try {
      if (raw) data = JSON.parse(raw);
    } catch {
      if (response.ok) throw new Error('The server returned an invalid response.');
    }
    if (!response.ok) {
      const code = data && typeof data === 'object' && 'code' in data ? String(data.code) : '';
      throw new Error(
        errors[code] ?? 'The server could not complete this action. Refresh and try again.',
      );
    }
    return data as T;
  }
}
