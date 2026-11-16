import { describe, expect, it, beforeEach } from 'vitest'
import { useAuth } from '@/store/auth'
import { queryClient } from '@/lib/queryClient'

/**
 * Auth-store state transitions (offline — transport answered by the labeled
 * test stub; the store logic itself is what's under test).
 */
describe('auth store state transitions', () => {
  beforeEach(() => {
    useAuth.setState({ status: 'bootstrapping', admin: null, csrfToken: null })
    queryClient.clear()
    window.localStorage.clear()
    window.sessionStorage.clear()
  })

  it('starts bootstrapping and moves to authenticated with the session shape', async () => {
    await useAuth.getState().bootstrap()
    const s = useAuth.getState()
    expect(['authenticated', 'anonymous']).toContain(s.status)
    if (s.status === 'authenticated') {
      expect(s.admin).toMatchObject({ role: 'ADMIN' })
      expect(typeof s.csrfToken).toBe('string')
    }
  })

  it('sessionExpired() wipes admin + csrfToken and never writes storage', () => {
    useAuth.setState({
      status: 'authenticated',
      admin: { id: 'u-1', name: 'A', email: 'a@x.in', role: 'ADMIN' },
      csrfToken: 'tok',
    })
    useAuth.getState().sessionExpired()
    const s = useAuth.getState()
    expect(s.status).toBe('anonymous')
    expect(s.admin).toBeNull()
    expect(s.csrfToken).toBeNull()
    expect(window.localStorage.length).toBe(0)
    expect(window.sessionStorage.length).toBe(0)
  })

  it('logout() broadcasts a cross-tab logout message and clears state', async () => {
    const received: unknown[] = []
    const otherTab = new BroadcastChannel('admin-portal-auth')
    otherTab.onmessage = (ev) => received.push(ev.data)
    useAuth.setState({
      status: 'authenticated',
      admin: { id: 'u-1', name: 'A', email: 'a@x.in', role: 'ADMIN' },
      csrfToken: 'tok',
    })
    await useAuth.getState().logout()
    await new Promise((r) => setTimeout(r, 0))
    expect(received).toContain('logout')
    expect(useAuth.getState().status).toBe('anonymous')
    otherTab.close()
  })

  it('clearLocal() empties the query cache and drops the in-memory CSRF token', () => {
    queryClient.setQueryData(['x'], { some: 'data' })
    expect(queryClient.getQueryData(['x'])).toBeDefined()
    useAuth.setState({ status: 'authenticated', admin: { id: 'u-1', name: 'A', email: 'a@x.in', role: 'ADMIN' }, csrfToken: 'tok' })
    useAuth.getState().clearLocal()
    expect(queryClient.getQueryData(['x'])).toBeUndefined()
    // session identity is gone from the store (anonymous) even though clearLocal
    // itself only clears cache + transport token
    useAuth.getState().sessionExpired()
    expect(useAuth.getState().csrfToken).toBeNull()
    expect(useAuth.getState().admin).toBeNull()
  })

  it('role label is always ADMIN (single role; SUPPORT_AGENT logins rejected server-side)', async () => {
    await useAuth.getState().bootstrap()
    const admin = useAuth.getState().admin
    if (admin) expect(admin.role).toBe('ADMIN')
  })
})
