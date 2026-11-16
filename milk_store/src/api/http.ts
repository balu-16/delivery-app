/**
 * The one HTTP client for the store portal. Cookie-authenticated
 * (store_session HttpOnly cookie, never in browser storage), CSRF-token
 * protected for state changes, timeouts on every request, and all failures
 * normalized to ApiError with the backend problem+json code.
 */

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly detail?: string,
  ) {
    super(detail || code)
    this.name = 'ApiError'
  }
}

let csrfToken: string | null = null

/** The login/session bootstrap responses hand the CSRF token to the client. */
export function setCsrfToken(token: string | null): void {
  csrfToken = token
}

export function getCsrfToken(): string | null {
  return csrfToken
}

export function newIdempotencyKey(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `idem-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

export interface RequestInitLite {
  body?: unknown
  idempotencyKey?: string
  timeoutMs?: number
}

async function request<T>(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, init?: RequestInitLite): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json' }
  if (init?.body !== undefined) headers['content-type'] = 'application/json'
  if (csrfToken && method !== 'GET') headers['x-store-csrf'] = csrfToken
  if (init?.idempotencyKey) headers['idempotency-key'] = init.idempotencyKey
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), init?.timeoutMs ?? 20000)
  let response: Response
  try {
    response = await fetch(path, {
      method,
      headers,
      credentials: 'same-origin',
      body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
      signal: controller.signal,
    })
  } catch (error) {
    clearTimeout(timer)
    throw new ApiError(0, 'NETWORK_ERROR', 'Network request failed — check your connection')
  }
  clearTimeout(timer)
  if (response.status === 204) return undefined as T
  const contentType = response.headers.get('content-type') ?? ''
  const payload: unknown = contentType.includes('json') ? await response.json().catch(() => null) : null
  if (!response.ok) {
    const problem = (payload ?? {}) as { code?: string; detail?: string; title?: string }
    throw new ApiError(
      response.status,
      problem.code ?? (response.status === 401 ? 'SESSION_EXPIRED' : 'REQUEST_FAILED'),
      problem.detail ?? problem.title ?? undefined,
    )
  }
  return (payload ?? undefined) as T
}

export function apiGet<T>(path: string, timeoutMs?: number): Promise<T> {
  return request<T>('GET', path, { timeoutMs })
}
export function apiPost<T>(path: string, body?: unknown, idempotencyKey?: string): Promise<T> {
  return request<T>('POST', path, { body, idempotencyKey })
}
export function apiPatch<T>(path: string, body?: unknown): Promise<T> {
  return request<T>('PATCH', path, { body })
}
export function apiDelete<T>(path: string): Promise<T> {
  return request<T>('DELETE', path)
}
