import type { components } from './customer.generated';

export type Problem = components['schemas']['ProblemDto'];

export class ApiError extends Error {
  constructor(public readonly status: number, public readonly code: string, public readonly traceId?: string) {
    super(code);
    this.name = 'ApiError';
  }
}

export function apiBaseUrl(): string {
  const raw = process.env.EXPO_PUBLIC_API_URL?.trim();
  if (!raw) throw new Error('Set EXPO_PUBLIC_API_URL to the customer backend URL.');
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error('EXPO_PUBLIC_API_URL is not a valid URL.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('EXPO_PUBLIC_API_URL must be an HTTP(S) base URL without credentials or query parameters.');
  }
  if (!__DEV__ && url.protocol !== 'https:') throw new Error('The customer API must use HTTPS.');
  return url.toString().replace(/\/$/, '');
}

type RequestOptions = { method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'; token?: string; body?: unknown; idempotencyKey?: string; signal?: AbortSignal };

/** One HTTP attempt. Money-moving commands must be retried only with the same idempotency key and body. */
export async function customerRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
  if (!path.startsWith('/') || path.startsWith('//')) throw new Error('Invalid API path.');
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  if (options.idempotencyKey) headers['Idempotency-Key'] = options.idempotencyKey;
  const response = await fetch(`${apiBaseUrl()}${path}`, {
    method: options.method ?? 'GET', headers,
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  });
  if (!response.ok) {
    const problem = await response.json().catch(() => null) as Partial<Problem> | null;
    throw new ApiError(response.status, typeof problem?.code === 'string' ? problem.code : 'REQUEST_FAILED', typeof problem?.traceId === 'string' ? problem.traceId : undefined);
  }
  if (response.status === 204 || response.headers.get('content-length') === '0') return undefined as T;
  const body = await response.text();
  return (body ? JSON.parse(body) : undefined) as T;
}
