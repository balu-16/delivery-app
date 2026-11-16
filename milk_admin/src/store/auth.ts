import { create } from 'zustand'
import { queryClient } from '@/lib/queryClient'
import { ApiError, setCsrfToken, setSessionExpiredHandler } from '@/api/http'
import * as authApi from '@/api/auth'
import type { AuthAdmin } from '@/types'

// Single admin-portal session. Cookie-only auth: the session cookie is HttpOnly
// (server set), the CSRF token lives in memory for the tab lifetime and is NEVER
// persisted to localStorage/sessionStorage/indexedDB.

/** Generic, code-aware auth copy — never reflects vendor messages or account existence. */
const AUTH_ERROR_COPY: Record<string, string> = {
  INVALID_CREDENTIALS: 'Invalid email or password.',
  INVALID_INPUT: 'Please check the form and try again.',
  INVALID_CHALLENGE: 'That sign-in attempt expired. Please sign in again.',
  INVALID_RESET: 'Invalid reset code or password.',
  RATE_LIMITED: 'Too many attempts. Please wait a minute and try again.',
  ExternalServiceUnavailable: 'The sign-in service is temporarily unavailable. Please retry in a moment.',
}

function authErrorMessage(err: unknown, fallback: string): string {
  if (err instanceof ApiError) {
    if (err.code === 'INVALID_CREDENTIALS') return AUTH_ERROR_COPY.INVALID_CREDENTIALS
    // Server/infrastructure failures must never read as "bad credentials".
    if (err.status >= 500) return 'Something went wrong on our side. Please try again in a moment.'
    return AUTH_ERROR_COPY[err.code] ?? fallback
  }
  return fallback
}

export interface AuthUser {
  id: string
  name: string
  email: string
  role: 'ADMIN'
}

export type AuthStatus = 'bootstrapping' | 'authenticated' | 'anonymous'

interface AuthState {
  status: AuthStatus
  admin: AuthUser | null
  csrfToken: string | null
  bootstrap: () => Promise<void>
  login: (email: string, password: string) => Promise<{ ok: boolean; challenge?: string; challengeId?: string; error?: string }>
  challenge: (challengeId: string, newPassword: string) => Promise<{ ok: boolean; error?: string }>
  forgotPassword: (email: string) => Promise<{ ok: boolean; error?: string }>
  confirmReset: (email: string, confirmationCode: string, newPassword: string) => Promise<{ ok: boolean; error?: string }>
  logout: () => Promise<void>
  sessionExpired: () => void
  clearLocal: () => void
}

/** Clear every cached query + local session state (no storage writes anywhere). */
function localClear() {
  setCsrfToken(null)
  queryClient.clear()
}

// ── Cross-tab logout broadcast ───────────────────────────────────────────────
const AUTH_CHANNEL = 'admin-portal-auth'
let channel: BroadcastChannel | null = null
function getChannel(): BroadcastChannel | null {
  if (typeof BroadcastChannel === 'undefined') return null
  if (!channel) {
    channel = new BroadcastChannel(AUTH_CHANNEL)
    channel.onmessage = () => {
      // Another tab logged out (or expired) — clear locally too.
      useAuth.getState().clearLocal()
    }
  }
  return channel
}

export const useAuth = create<AuthState>()((set, getState) => {
  // Wire the http layer's 401 handler once.
  setSessionExpiredHandler(() => getState().sessionExpired())

  return {
    status: 'bootstrapping',
    admin: null,
    csrfToken: null,

    bootstrap: async () => {
      try {
        const session = await authApi.getSession()
        setCsrfToken(session.csrfToken)
        set({
          status: 'authenticated',
          admin: { id: session.admin.userId, name: session.admin.name, email: session.admin.email, role: 'ADMIN' },
          csrfToken: session.csrfToken,
        })
      } catch {
        set({ status: 'anonymous', admin: null, csrfToken: null })
      }
    },

    login: async (email, password) => {
      try {
        const res = await authApi.login(email, password)
        if (res.status === 'CHALLENGE') {
          return { ok: false, challenge: res.challenge, challengeId: res.challengeId }
        }
        setCsrfToken(res.csrfToken)
        set({
          status: 'authenticated',
          admin: { id: res.admin.userId, name: res.admin.name, email: res.admin.email, role: 'ADMIN' },
          csrfToken: res.csrfToken,
        })
        return { ok: true }
      } catch (err) {
        return { ok: false, error: authErrorMessage(err, 'Invalid email or password.') }
      }
    },

    challenge: async (challengeId, newPassword) => {
      try {
        const res = await authApi.challenge(challengeId, newPassword)
        setCsrfToken(res.csrfToken)
        set({
          status: 'authenticated',
          admin: { id: res.admin.userId, name: res.admin.name, email: res.admin.email, role: 'ADMIN' },
          csrfToken: res.csrfToken,
        })
        return { ok: true }
      } catch (err) {
        return { ok: false, error: authErrorMessage(err, 'Could not set the new password.') }
      }
    },

    forgotPassword: async (email) => {
      try {
        await authApi.forgotPassword(email)
        return { ok: true }
      } catch {
        // Always generic — never reveal whether the account exists.
        return { ok: true }
      }
    },

    confirmReset: async (email, confirmationCode, newPassword) => {
      try {
        await authApi.confirmReset(email, confirmationCode, newPassword)
        return { ok: true }
      } catch (err) {
        return { ok: false, error: authErrorMessage(err, 'Invalid reset code or password.') }
      }
    },

    logout: async () => {
      try {
        await authApi.logout()
      } catch {
        // Best effort — session cookie may already be gone.
      }
      getState().clearLocal()
      getChannel()?.postMessage('logout')
      set({ status: 'anonymous', admin: null, csrfToken: null })
    },

    sessionExpired: () => {
      if (getState().status === 'anonymous') return
      getState().clearLocal()
      getChannel()?.postMessage('logout')
      set({ status: 'anonymous', admin: null, csrfToken: null })
    },

    clearLocal: () => {
      localClear()
    },
  }
})

export type { AuthAdmin }
