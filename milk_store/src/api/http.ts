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

/**
 * Re-authentication hook: registered by the auth layer so a stale CSRF token
 * (module reload, HMR, or an expired session) can be repaired transparently.
 * Mutating requests that fail with 401 SESSION_EXPIRED / 403 CSRF_TOKEN_INVALID
 * re-bootstrap the cookie session once and retry.
 */
let reauthHook: (() => Promise<void>) | null = null
export function setReauthHook(fn: (() => Promise<void>) | null): void {
  reauthHook = fn
}

/** Concurrent stale-credential failures share one in-flight re-auth. */
let reauthPromise: Promise<void> | null = null
async function reauthenticate(): Promise<void> {
  if (!reauthPromise) {
    reauthPromise = (async () => {
      await reauthHook!()
    })().finally(() => {
      reauthPromise = null
    })
  }
  return reauthPromise
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

async function requestOnce<T>(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, init?: RequestInitLite): Promise<T> {
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

/** Mutating request with one transparent re-auth + retry on stale credentials. */
async function request<T>(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  path: string,
  init?: RequestInitLite,
  retried = false,
): Promise<T> {
  try {
    return await requestOnce<T>(method, path, init)
  } catch (error) {
    const status = (error as ApiError).status
    const code = (error as ApiError).code
    const stale = retried === false && method !== 'GET' && reauthHook !== null &&
      ((status === 403 && code === 'CSRF_TOKEN_INVALID') || (status === 401 && code === 'SESSION_EXPIRED'))
    if (!stale) throw error
    await reauthenticate()
    return requestOnce<T>(method, path, init)
  }
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
