/**
 * Real-server reachability probe + transport wiring for REAL-mode tests.
 *
 * When the backend (default http://localhost:3000, override with
 * TEST_API_BASE) answers /v1/admin/auth/session with ANY http response, the
 * suite runs server-dependent tests against the REAL contract through
 * src/api/http.ts (real fetch). When it is unreachable, those tests SKIP with
 * an explicit reason — they never silently pass against synthetic data.
 *
 * In REAL mode globalThis.fetch is wrapped with a thin transport shim that
 * (a) resolves the app's relative /v1 paths against the server base and
 * (b) maintains a cookie jar so the cookie-authenticated session survives
 * across requests (jsdom/undici do not keep cookies between requests).
 * This shim carries NO data — it is transport only.
 */

import { pristineFetch } from './mockServer'

export const apiBase = process.env.TEST_API_BASE ?? 'http://localhost:3000'

const cookieJar = new Map<string, string>()

let probePromise: Promise<boolean> | null = null

async function probeOnce(): Promise<boolean> {
  // NOTE: no AbortSignal — jsdom's AbortSignal is not undici-compatible and
  // Node fetch rejects it; a plain timeout race is transport-safe.
  try {
    const probe = pristineFetch(`${apiBase}/v1/admin/auth/session`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
    })
    const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error('probe-timeout')), 4000))
    const res = await Promise.race([probe, timeout])
    // Any HTTP response (200 session, 401 SESSION_EXPIRED, 403 …) means the
    // server is up and speaking the admin contract.
    return res.status > 0
  } catch {
    return false
  }
}

export function probeServer(): Promise<boolean> {
  if (!probePromise) probePromise = probeOnce()
  return probePromise
}

let fetchPatched = false

/** Install the REAL-mode transport shim (relative-path rewrite + cookie jar). */
function installRealTransport() {
  if (fetchPatched) return
  fetchPatched = true
  const realFetch = pristineFetch
  const patched = (async (input: RequestInfo | URL, init?: RequestInit) => {
    let url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    if (url.startsWith('/')) url = `${apiBase}${url}`
    const headers = new Headers(init?.headers ?? (typeof input !== 'string' && !(input instanceof URL) ? input.headers : undefined))
    const cookie = cookieJar.get('admin_session')
    if (cookie) headers.set('Cookie', `admin_session=${cookie}`)
    const res = await realFetch(url, { ...init, headers, credentials: 'include' })
    const setCookie = res.headers.get('set-cookie')
    if (setCookie) {
      const match = /admin_session=([^;]+)/.exec(setCookie)
      if (match) cookieJar.set('admin_session', match[1]!)
    }
    return res
  }) as typeof fetch
  ;(globalThis as { fetch: typeof fetch }).fetch = patched
}

/** Memoized mode setup — call (and await) at the top of REAL-mode suites. */
export async function setupRealMode(): Promise<boolean> {
  const up = await probeServer()
  if (up) installRealTransport()
  return up
}

export function clearSessionCookie() {
  cookieJar.delete('admin_session')
}

export function hasSessionCookie(): boolean {
  return cookieJar.has('admin_session')
}

export interface RealCreds {
  email: string
  password: string
  available: boolean
}

/** Optional admin credentials for authenticated REAL-mode tests. */
export function realCreds(): RealCreds {
  const email = process.env.TEST_ADMIN_EMAIL
  const password = process.env.TEST_ADMIN_PASSWORD
  return { email: email ?? '', password: password ?? '', available: !!(email && password) }
}
