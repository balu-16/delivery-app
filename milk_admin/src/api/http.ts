// ── The ONLY fetch wrapper for the admin portal ─────────────────────────────
// Same-origin requests, cookie-only auth (credentials: 'include'), CSRF token
// header on mutations. Tokens/session data NEVER touch web storage.

export interface ProblemBody {
  type?: string
  title?: string
  status?: number
  code?: string
  detail?: string
  traceId?: string
}

export class ApiError extends Error {
  status: number
  code: string
  detail: string
  retryAfter: number | null
  traceId: string | null

  constructor(status: number, body: ProblemBody | null, retryAfterHeader: string | null, fallback?: string) {
    super(body?.detail || body?.title || fallback || `Request failed (${status})`)
    this.name = 'ApiError'
    this.status = status
    this.code = body?.code ?? `HTTP_${status}`
    this.detail = body?.detail ?? body?.title ?? ''
    const ra = retryAfterHeader != null ? Number(retryAfterHeader) : NaN
    this.retryAfter = Number.isFinite(ra) ? ra : null
    this.traceId = body?.traceId ?? null
  }
}

type QueryValue = string | number | boolean | null | undefined

/** Build a querystring, skipping empty values. */
export function buildQuery(params: Record<string, QueryValue>): string {
  const qs = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue
    qs.set(key, String(value))
  }
  const s = qs.toString()
  return s ? `?${s}` : ''
}

// ── CSRF token wiring (set by the auth store after login/session bootstrap) ──
let csrfToken: string | null = null
let onSessionExpired: (() => void) | null = null

export function setCsrfToken(token: string | null) {
  csrfToken = token
}

/** Register the session-expiry handler (auth store) — invoked on 401 cookie sessions. */
export function setSessionExpiredHandler(fn: (() => void) | null) {
  onSessionExpired = fn
}

function handleAuthFailure(status: number, body: ProblemBody | null) {
  const code = body?.code
  if (status === 401 && (code === 'SESSION_EXPIRED' || code === 'SESSION_REPLACED' || code === 'INVALID_TOKEN')) {
    onSessionExpired?.()
    return
  }
  // 403 FORBIDDEN = account disabled or role revoked — treat the session as gone.
  if (status === 403 && code === 'FORBIDDEN') onSessionExpired?.()
}

async function parseBody(res: Response): Promise<unknown> {
  const text = await res.text()
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  body?: unknown
  headers?: Record<string, string>
  /** Skip the automatic 401 → sessionExpired dispatch (auth endpoints). */
  raw401?: boolean
}

async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const method = opts.method ?? 'GET'
  const headers: Record<string, string> = { Accept: 'application/json', ...(opts.headers ?? {}) }
  if (method !== 'GET') {
    headers['Content-Type'] = 'application/json'
    if (csrfToken) headers['x-admin-csrf'] = csrfToken
  }
  const res = await fetch(path, {
    method,
    credentials: 'include',
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  })

  if (!res.ok) {
    const body = (await parseBody(res)) as ProblemBody | null
    if (!opts.raw401) handleAuthFailure(res.status, body)
    throw new ApiError(res.status, body, res.headers.get('Retry-After'))
  }
  return (await parseBody(res)) as T
}

export const get = <T>(path: string): Promise<T> => request<T>(path, { method: 'GET' })
export const post = <T>(path: string, body?: unknown, headers?: Record<string, string>): Promise<T> =>
  request<T>(path, { method: 'POST', body: body ?? {}, headers })
export const put = <T>(path: string, body?: unknown, headers?: Record<string, string>): Promise<T> =>
  request<T>(path, { method: 'PUT', body: body ?? {}, headers })
export const patch = <T>(path: string, body?: unknown): Promise<T> =>
  request<T>(path, { method: 'PATCH', body: body ?? {} })
export const del = <T>(path: string, body?: unknown): Promise<T> =>
  request<T>(path, { method: 'DELETE', body: body ?? {} })

/** POST/PATCH with an Idempotency-Key header (captured once per intent by the caller). */
export function sendIdempotent<T>(
  method: 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  path: string,
  body: unknown,
  idempotencyKey: string,
): Promise<T> {
  return request<T>(path, { method, body, headers: { 'Idempotency-Key': idempotencyKey } })
}

/** Grab a fresh random idempotency key — captured ONCE per user intent. */
export function newIdempotencyKey(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `idem-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

/** Download helper — opens a server-provided URL in a new tab (no client-side file generation). */
export function openDownloadUrl(url: string) {
  window.open(url, '_blank', 'noopener,noreferrer')
}
