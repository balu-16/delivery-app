import { describe, expect, it } from 'vitest'
import * as authApi from '@/login/authApi'
import { STORE_PAGE_IMPORTS, STORE_NAV_PATH_IMPORTS } from '@/routes'
import { rupeesToPaise } from '@/api/storeMutations'

describe('store-web auth boundary', () => {
  it('exposes the server session client and not the retired demo sign-in', () => {
    expect(authApi.login).toBeTypeOf('function')
    expect(authApi.bootstrapSession).toBeTypeOf('function')
    expect(authApi.completeChallenge).toBeTypeOf('function')
    expect('signIn' in authApi).toBe(false)
  })

  it('converts rupees to integer paise', () => {
    expect(rupeesToPaise(70)).toBe('7000')
    expect(rupeesToPaise(10.5)).toBe('1050')
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
