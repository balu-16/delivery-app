import type { components } from './customer.generated';
import { developmentHost, developmentPort, resolveApiAddress } from './address';

export { ApiAddressError } from './address';

export type Problem = components['schemas']['ProblemDto'];

export class ApiError extends Error {
  constructor(public readonly status: number, public readonly code: string, public readonly traceId?: string) {
    super(code);
    this.name = 'ApiError';
  }
}

export function apiBaseUrl(): string {
  return resolveApiAddress({ configuredUrl: process.env.EXPO_PUBLIC_API_URL, development: __DEV__,
    developmentHost: __DEV__ ? developmentHost() : undefined, developmentPort: __DEV__ ? developmentPort() : undefined });
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
