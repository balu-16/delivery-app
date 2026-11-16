import { describe, expect, it } from 'vitest'
import { signIn } from '@/login/authApi'
import { STORE_PAGE_IMPORTS, STORE_NAV_PATH_IMPORTS } from '@/routes'

describe('store-web auth boundary', () => {
  it('accepts a store-manager account and reports assigned stores', async () => {
    const res = await signIn('chaitanya.raju@srm.edu.in', 'Store@123')
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.user.assignedStoreIds.length).toBeGreaterThan(0)
    }
  })

  it("rejects an admin account with the cross-portal message", async () => {
    const res = await signIn('admin@dairydirect.in', 'Admin@123')
    expect(res).toEqual({ ok: false, error: "This account can't sign in here" })
  })

  it('rejects wrong password generically', async () => {
    const res = await signIn('chaitanya.raju@srm.edu.in', 'nope')
    expect(res).toEqual({ ok: false, error: 'Invalid email or password' })
  })
})

describe('store-web routes', () => {
  it('covers the 9 store sections', () => {
    expect(Object.keys(STORE_PAGE_IMPORTS)).toHaveLength(9)
  })
  it('nav prefetch map has no /store prefix', () => {
    for (const path of Object.keys(STORE_NAV_PATH_IMPORTS)) expect(path.startsWith('/store')).toBe(false)
    expect(STORE_NAV_PATH_IMPORTS['/dashboard']).toBeTruthy()
  })
})
