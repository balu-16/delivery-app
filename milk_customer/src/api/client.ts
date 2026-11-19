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

type RequestOptions = { method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'; token?: string; body?: unknown; idempotencyKey?: string; signal?: AbortSignal; timeoutMs?:number };

/** One HTTP attempt. Money-moving commands must be retried only with the same idempotency key and body. */
export async function customerRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
  if (!path.startsWith('/') || path.startsWith('//')) throw new Error('Invalid API path.');
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  if (options.idempotencyKey) headers['Idempotency-Key'] = options.idempotencyKey;
  // Plan2 budget: ordinary reads/writes 12s; quote/place override to 20s/30s.
  const timeoutMs = options.timeoutMs ?? 12000;
  const controller=timeoutMs ? new AbortController() : null;
  const abort = () => controller?.abort();
  if (controller && options.signal) {
    if (options.signal.aborted) controller.abort();
    else options.signal.addEventListener('abort',abort,{once:true});
  }
  const timer=controller ? setTimeout(abort,timeoutMs) : null;
  try {
    const response = await fetch(`${apiBaseUrl()}${path}`, {
      method: options.method ?? 'GET', headers,
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
      ...(controller ? {signal:controller.signal} : options.signal ? { signal: options.signal } : {}),
    });
    if (!response.ok) {
      const problem = await response.json().catch(() => null) as Partial<Problem> | null;
      throw new ApiError(response.status, typeof problem?.code === 'string' ? problem.code : 'REQUEST_FAILED', typeof problem?.traceId === 'string' ? problem.traceId : undefined);
    }
    if (response.status === 204 || response.headers.get('content-length') === '0') return undefined as T;
    const body = await response.text();
    return (body ? JSON.parse(body) : undefined) as T;
  } finally {
    if (timer) clearTimeout(timer);
    if (controller && options.signal) options.signal.removeEventListener('abort',abort);
  }
}
