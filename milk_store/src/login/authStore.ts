import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { queryClient } from '@dairydirect/shared/lib/queryClient'
import {
  bootstrapSession,
  completeChallenge,
  login as apiLogin,
  logout as apiLogout,
  type ManagerPayload,
  type StoreAuthUser,
} from './authApi'

/**
 * Store-web auth store. The credential is the server's HttpOnly
 * `store_session` cookie — nothing sensitive lives in browser storage, so a
 * page refresh bootstraps from GET /v1/store/auth/session. The key below is
 * only a logout broadcast handle, independent from admin-web.
 */
interface StoreAuthState {
  status: 'loading' | 'anonymous' | 'authenticated'
  user: StoreAuthUser | null
  /** Server idle deadline for the current cookie session. */
  idleExpiresAt: string | null
  /** Set when the provider demanded a first-login password change. */
  pendingChallengeId: string | null
  bootstrap: () => Promise<void>
  login: (
    email: string,
    password: string,
    remember?: boolean,
  ) => Promise<{ ok: boolean; challenge?: boolean; error?: string }>
  completeFirstLogin: (newPassword: string) => Promise<{ ok: boolean; error?: string }>
  logout: () => Promise<void>
  /** Cross-tab sync: clears state without hitting the server. */
  adoptSignedOut: () => void
  setUser: (user: StoreAuthUser) => void
}

export const useStoreAuth = create<StoreAuthState>()((set, get) => ({
  status: 'loading',
  user: null,
  idleExpiresAt: null,
  pendingChallengeId: null,
  bootstrap: async () => {
    try {
      const session = await bootstrapSession()
      set({
        status: session ? 'authenticated' : 'anonymous',
        user: session?.user ?? null,
        idleExpiresAt: session?.idleExpiresAt ?? null,
      })
    } catch {
      set({ status: 'anonymous', user: null, idleExpiresAt: null })
    }
  },
  login: async (email, password, remember = true) => {
    if (!email || !password) return { ok: false, error: 'Invalid email or password' }
    const outcome = await apiLogin(email, password, remember)
    if (outcome.status === 'CHALLENGE') {
      set({ pendingChallengeId: outcome.challengeId })
      return { ok: false, challenge: true }
    }
    set({
      status: 'authenticated',
      user: toUserState(outcome.manager),
      idleExpiresAt: outcome.idleExpiresAt ?? null,
      pendingChallengeId: null,
    })
    return { ok: true }
  },
  completeFirstLogin: async (newPassword) => {
    const challengeId = get().pendingChallengeId
    if (!challengeId) return { ok: false, error: 'No pending first-login challenge' }
    const outcome = await completeChallenge(challengeId, newPassword)
    set({
      status: 'authenticated',
      user: toUserState(outcome.manager),
      idleExpiresAt: outcome.idleExpiresAt ?? null,
      pendingChallengeId: null,
    })
    return { ok: true }
  },
  logout: async () => {
    try {
      await apiLogout()
    } finally {
      // Sensitive queries never outlive the session.
      queryClient.clear()
      set({ status: 'anonymous', user: null, idleExpiresAt: null, pendingChallengeId: null })
    }
  },
  adoptSignedOut: () => set({ status: 'anonymous', user: null, idleExpiresAt: null, pendingChallengeId: null }),
  setUser: (user) => set({ status: 'authenticated', user }),
}))

function toUserState(manager: ManagerPayload): StoreAuthUser {
  return {
    id: manager.userId,
    email: manager.email,
    name: manager.name,
    role: 'store_manager',
    stores: manager.stores ?? [],
    assignedStoreIds: (manager.stores ?? []).map((s) => s.storeId),
  }
}

/** Active store for the manager portal (remembered across sessions, validated against assignments). */
interface ActiveStoreState {
  activeStoreId: string | null
  setActiveStore: (id: string) => void
}
export const useActiveStore = create<ActiveStoreState>()(
  persist(
    (set) => ({
      activeStoreId: null,
      setActiveStore: (id) => {
        set({ activeStoreId: id })
        queryClient.removeQueries({ queryKey: ['store'] })
      },
    }),
    { name: 'dd_store_active_store', partialize: (s) => ({ activeStoreId: s.activeStoreId }) },
  ),
)
