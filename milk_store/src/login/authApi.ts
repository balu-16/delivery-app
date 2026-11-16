/**
 * Store-manager portal session API (server-managed cookie sessions). The
 * HttpOnly `store_session` cookie is the credential; access tokens never
 * touch browser storage. `manager.stores` drives the store selector.
 */
import { apiGet, apiPost, setCsrfToken } from '../api/http'

export interface StoreAssignment {
  storeId: string
  role: 'STORE_MANAGER'
  name: string
}

export interface StoreAuthUser {
  id: string
  email: string
  name: string
  avatar?: string
  role: 'store_manager'
  stores: StoreAssignment[]
  /** Convenience for existing hooks: ordered assigned store ids. */
  assignedStoreIds: string[]
}

/** The manager object exactly as the backend returns it. */
export interface ManagerPayload {
  userId: string
  email: string
  name: string
  stores?: StoreAssignment[]
}

export interface AuthenticatedOutcome {
  status: 'AUTHENTICATED'
  manager: ManagerPayload
  csrfToken: string
}

export interface ChallengeOutcome {
  status: 'CHALLENGE'
  challenge: 'NEW_PASSWORD_REQUIRED'
  challengeId: string
}

export type LoginOutcome = AuthenticatedOutcome | ChallengeOutcome

function toUser(manager: { userId: string; email: string; name: string; stores?: StoreAssignment[] }): StoreAuthUser {
  return {
    id: manager.userId,
    email: manager.email,
    name: manager.name,
    role: 'store_manager',
    stores: manager.stores ?? [],
    assignedStoreIds: (manager.stores ?? []).map((s) => s.storeId),
  }
}

function adoptCsrf(token: string | null): void {
  setCsrfToken(token)
}

export async function login(email: string, password: string, remember = true): Promise<LoginOutcome> {
  const outcome = await apiPost<LoginOutcome>('/v1/store/auth/login', { email, password, remember })
  if (outcome.status === 'AUTHENTICATED') adoptCsrf(outcome.csrfToken)
  return outcome
}

export async function completeChallenge(
  challengeId: string,
  newPassword: string,
): Promise<AuthenticatedOutcome> {
  const outcome = await apiPost<AuthenticatedOutcome>('/v1/store/auth/challenge', {
    challengeId,
    newPassword,
  })
  adoptCsrf(outcome.csrfToken)
  return outcome
}

/** Refresh bootstrap: resolves the cookie session, rotating it when needed. */
export async function bootstrapSession(): Promise<StoreAuthUser | null> {
  try {
    const result = await apiGet<{ manager: ManagerPayload; csrfToken: string }>(
      '/v1/store/auth/session',
    )
    adoptCsrf(result.csrfToken)
    return toUser(result.manager)
  } catch (error) {
    adoptCsrf(null)
    if ((error as { status?: number }).status === 401) return null
    throw error
  }
}

export async function forgotPassword(email: string): Promise<void> {
  await apiPost('/v1/store/auth/forgot-password', { email })
}

export async function confirmForgotPassword(
  email: string,
  confirmationCode: string,
  newPassword: string,
): Promise<void> {
  await apiPost('/v1/store/auth/forgot-password/confirm', {
    email,
    confirmationCode,
    newPassword,
  })
}

export async function logout(allSessions = false): Promise<void> {
  try {
    await apiPost('/v1/store/auth/logout', { allSessions })
  } finally {
    adoptCsrf(null)
  }
}

