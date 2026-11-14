import { describe, expect, it, beforeAll } from 'vitest'
import { setupRealMode, realCreds, clearSessionCookie } from '../serverProbe'
import { ApiError, setCsrfToken } from '@/api/http'
import * as authApi from '@/api/auth'
import * as dashboardApi from '@/api/dashboard'
import * as storesApi from '@/api/stores'
import * as ordersApi from '@/api/orders'
import * as paymentsApi from '@/api/payments'
import * as catalogApi from '@/api/catalog'
import * as inventoryApi from '@/api/inventory'
import * as supportApi from '@/api/support'
import * as reportsApi from '@/api/reports'
import * as approvalsApi from '@/api/approvals'
import * as settingsApi from '@/api/settings'
import * as offersApi from '@/api/offers'
import * as peopleApi from '@/api/people'

/**
 * REAL-SERVER CONTRACT TESTS (primary mode).
 * Run against the actual NestJS backend through src/api/http.ts with real
 * fetch. When the server (or its DB) is unreachable the whole suite SKIPS —
 * it never validates against synthetic data.
 */
const serverUp = await setupRealMode()
const creds = realCreds()

describe.skipIf(!serverUp)('REAL admin API contract', () => {
  beforeAll(() => {
    clearSessionCookie()
    setCsrfToken(null)
  })

  it('GET /v1/admin/auth/session answers 200 (session) or 401 SESSION_EXPIRED in problem+json shape', async () => {
    try {
      const session = await authApi.getSession()
      expect(session.admin).toMatchObject({ role: 'ADMIN' })
      expect(typeof session.csrfToken).toBe('string')
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError)
      expect((err as ApiError).status).toBe(401)
      expect(['SESSION_EXPIRED', 'SESSION_REPLACED', 'INVALID_TOKEN', 'FORBIDDEN']).toContain((err as ApiError).code)
    }
  })

  it('unauthenticated lists answer problem+json errors (401/403) with code + traceId', async () => {
    clearSessionCookie()
    setCsrfToken(null)
    const err = await ordersApi.listOrders({ limit: 5 }).then(
      () => null,
      (e: unknown) => e as ApiError,
    )
    expect(err).toBeInstanceOf(ApiError)
    expect([401, 403]).toContain(err!.status)
    expect(err!.code).toBeTruthy()
  })

  it('GET /v1/admin/dashboard returns the pinned shape (or an auth problem)', async () => {
    try {
      const data = await dashboardApi.getDashboard('30d')
      expect(data).toHaveProperty('period')
      expect(data).toHaveProperty('orders')
      expect(data).toHaveProperty('stores')
      // money fields are paise STRINGS when present
      if (data.invoicedSalesPaise != null) expect(typeof data.invoicedSalesPaise).toBe('string')
    } catch (err) {
      expect([401, 403]).toContain((err as ApiError).status)
    }
  })

  it('cursor lists return {items, nextCursor} (orders, attempts, refunds, tickets)', async () => {
    for (const call of [
      () => ordersApi.listOrders({ limit: 5 }),
      () => paymentsApi.listPaymentAttempts({ limit: 5 }),
      () => paymentsApi.listRefunds({ limit: 5 }),
      () => supportApi.listTickets(undefined, 5),
      () => storesApi.listStores(5),
      () => catalogApi.listProducts(5),
      () => inventoryApi.inventorySummary({ limit: 5 }),
      () => approvalsApi.listApprovals(undefined, 5),
      () => offersApi.listCoupons(5),
      () => peopleApi.listUsers({ limit: 5 }),
    ]) {
      try {
        const page = await call()
        expect(Array.isArray(page.items)).toBe(true)
        expect('nextCursor' in page).toBe(true)
        expect(page.nextCursor === null || typeof page.nextCursor === 'string').toBe(true)
      } catch (err) {
        // without a session the surface must still answer with a contract problem
        expect([401, 403]).toContain((err as ApiError).status)
        expect((err as ApiError).code).toBeTruthy()
      }
    }
  })

  it('GET /v1/admin/config returns {config, flags} (flags default true in the UI when absent)', async () => {
    try {
      const snap = await settingsApi.getConfig()
      expect(typeof snap.config).toBe('object')
      expect(typeof snap.flags).toBe('object')
    } catch (err) {
      expect([401, 403]).toContain((err as ApiError).status)
    }
  })

  it('reports preview + exports list respond with cursor pages (or auth problems)', async () => {
    try {
      const preview = await reportsApi.reportPreview('financial', { limit: 5 })
      expect(Array.isArray(preview.items)).toBe(true)
    } catch (err) {
      expect([401, 403]).toContain((err as ApiError).status)
    }
    try {
      const jobs = await reportsApi.listReportExports(undefined, 5)
      expect(Array.isArray(jobs.items)).toBe(true)
    } catch (err) {
      expect([401, 403]).toContain((err as ApiError).status)
    }
  })

  // ── Authenticated flow — needs TEST_ADMIN_EMAIL / TEST_ADMIN_PASSWORD ──
  describe.skipIf(!creds.available)('with real admin credentials', () => {
    it('login → session → logout round-trips on real cookies + x-admin-csrf', async () => {
      const login = await authApi.login(creds.email, creds.password)
      if (login.status !== 'AUTHENTICATED') throw new Error('expected AUTHENTICATED')
      expect(login.admin.role).toBe('ADMIN')

      const session = await authApi.getSession()
      expect(session.admin.email.toLowerCase()).toBe(creds.email.toLowerCase())

      // CSRF is in memory; logout must send it on the cookie-authenticated mutation
      setCsrfToken(login.csrfToken)
      const out = await authApi.logout()
      expect(out.status).toBe('LOGGED_OUT')
      clearSessionCookie()
    })

    it('bad credentials return 401 INVALID_CREDENTIALS (never leaks account existence)', async () => {
      const err = await authApi.login(creds.email, 'definitely-wrong-password').then(
        () => null,
        (e: unknown) => e as ApiError,
      )
      expect(err).toBeInstanceOf(ApiError)
      expect(err!.status).toBe(401)
      expect(err!.code).toBe('INVALID_CREDENTIALS')
    })
  })
})
